import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import postgres from "postgres";

// Stories against a real Postgres: the rollup on the task list and detail,
// the auto-close on the last child, and the dispatcher skipping a story by
// type whatever its status. Set PINBOARD_TEST_DATABASE_URL to a server the
// test may create and drop a scratch database on; without it the whole file
// is skipped.
const adminUrl = process.env.PINBOARD_TEST_DATABASE_URL;
const scratchDb = `pinboard_stories_${process.pid}`;
if (adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = `/${scratchDb}`;
  process.env.DATABASE_URL = url.toString();
}

const { sql } = await import("./db/client.js");
const { registerRoutes } = await import("./routes.js");

const app: FastifyInstance = Fastify();
await registerRoutes(app);

const human = { actorType: "human", actorName: "op" };

describe("stories against a real database", { skip: adminUrl ? false : "PINBOARD_TEST_DATABASE_URL unset" }, () => {
  let admin: ReturnType<typeof postgres>;
  let projectId: number;

  const create = async (payload: Record<string, unknown>): Promise<number> => {
    const res = await app.inject({ method: "POST", url: "/tasks", payload: { projectId, ...payload } });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id as number;
  };
  // children are written straight to their status, past the readiness gate
  // and the pipeline's legal moves, which are not what this test is about.
  const child = async (storyId: number, status: string, direction: "parent" | "child" = "parent"): Promise<number> => {
    const id = await create({ title: `${status} child`, executorMode: "agent" });
    await sql`UPDATE tasks SET status = ${status} WHERE id = ${id}`;
    const rel =
      direction === "parent"
        ? await app.inject({ method: "POST", url: `/tasks/${id}/relations`, payload: { toTaskId: storyId, relationType: "parent" } })
        : await app.inject({ method: "POST", url: `/tasks/${storyId}/relations`, payload: { toTaskId: id, relationType: "child" } });
    assert.equal(rel.statusCode, 201, rel.body);
    return id;
  };
  const statusOf = async (id: number): Promise<string> => (await sql<{ status: string }[]>`SELECT status FROM tasks WHERE id = ${id}`)[0].status;

  before(async () => {
    admin = postgres(adminUrl!, { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.unsafe(`CREATE DATABASE ${scratchDb}`);
    const conn = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
    await conn.end({ timeout: 0 });
    const res = await app.inject({ method: "POST", url: "/projects", payload: { slug: "stories", name: "Stories" } });
    projectId = res.json().id;
  });

  after(async () => {
    await sql.end({ timeout: 0 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.end({ timeout: 0 });
  });

  test("a story created as decomposed is stored as defined", async () => {
    const id = await create({ title: "old caller", taskType: "story", status: "decomposed" });
    assert.equal(await statusOf(id), "defined");
    const unset = await create({ title: "no status", taskType: "story" });
    assert.equal(await statusOf(unset), "defined");
  });

  test("the task list and detail carry each story's rollup, other tasks none", async () => {
    const story = await create({ title: "busy story", taskType: "story", status: "defined" });
    await child(story, "done");
    await child(story, "rejected");
    await child(story, "in_progress");
    await child(story, "awaiting_ci", "child");
    // related both ways: still one child
    const both = await child(story, "queued");
    await app.inject({ method: "POST", url: `/tasks/${story}/relations`, payload: { toTaskId: both, relationType: "child" } });
    const empty = await create({ title: "empty story", taskType: "story", status: "defined" });

    const expected = { phase: "in_progress", counts: { done: 1, in_progress: 1, pipeline: 1, ready: 1 } };
    for (const view of ["?view=summary", ""]) {
      const res = await app.inject({ url: `/tasks${view}${view ? "&" : "?"}projectId=${projectId}` });
      assert.equal(res.statusCode, 200, res.body);
      const rows = res.json() as { id: number; taskType: string; rollup?: unknown }[];
      assert.deepEqual(rows.find((t) => t.id === story)!.rollup, expected, view);
      assert.deepEqual(rows.find((t) => t.id === empty)!.rollup, { phase: "backlog", counts: {} }, view);
      for (const t of rows.filter((r) => r.taskType !== "story")) assert.equal(t.rollup, undefined);
    }
    const detail = await app.inject({ url: `/tasks/${story}` });
    assert.deepEqual(detail.json().rollup, expected);
    const plain = await app.inject({ url: `/tasks/${both}` });
    assert.equal(plain.json().rollup, undefined);

    // a child waiting on a human outranks the running one
    const asking = await child(story, "needs_input");
    assert.equal((await app.inject({ url: `/tasks/${story}` })).json().rollup.phase, "needs_you");
    await sql`UPDATE tasks SET status = 'rejected' WHERE id = ${asking}`;
  });

  test("a story closes itself when its last child is done or rejected, not before", async () => {
    const story = await create({ title: "closing story", taskType: "story", status: "defined" });
    const first = await child(story, "review");
    const second = await child(story, "verifying");

    const approved = await app.inject({ method: "POST", url: `/tasks/${first}/complete`, payload: human });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(await statusOf(story), "defined");

    const rejected = await app.inject({ method: "PATCH", url: `/tasks/${second}`, payload: { ...human, status: "rejected" } });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(await statusOf(story), "done");
    const detail = await app.inject({ url: `/tasks/${story}` });
    assert.deepEqual(detail.json().rollup, { phase: "done", counts: { done: 1 } });
  });

  test("the dispatcher skips a story by its type, whatever its status", async () => {
    const story = await create({ title: "queued story", taskType: "story", status: "defined", autonomyLevel: 1 });
    const runnable = await create({ title: "runnable", autonomyLevel: 1, estimatedEffort: 1 });
    await sql`UPDATE tasks SET status = 'queued', executor_mode = 'agent' WHERE id IN (${story}, ${runnable})`;
    const gate = await app.inject({ url: `/plan/gate/${story}` });
    assert.equal(gate.statusCode, 200, gate.body);
    assert.equal(gate.json().ok, false);
    assert.match(gate.json().reason, /is a story/);
    const next = await app.inject({ url: "/plan/next?override=true" });
    assert.equal(next.statusCode, 200, next.body);
    const offered = next.json().tasks.map((t: { taskId: number }) => t.taskId);
    assert.ok(offered.includes(runnable), next.body);
    assert.ok(!offered.includes(story), "a story is never offered");
    await sql`UPDATE tasks SET status = 'defined' WHERE id IN (${story}, ${runnable})`;
  });
});
