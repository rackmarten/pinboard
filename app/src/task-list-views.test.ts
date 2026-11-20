import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import postgres from "postgres";

// GET /tasks?view=summary, ?doneSince= and GET /tasks/counts. The
// database-backed tests need PINBOARD_TEST_DATABASE_URL, as in
// reasoning-effort.test.ts; without it only the validation tests run.
const adminUrl = process.env.PINBOARD_TEST_DATABASE_URL;
const scratchDb = `pinboard_task_list_views_${process.pid}`;
if (adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = `/${scratchDb}`;
  process.env.DATABASE_URL = url.toString();
}

const { sql } = await import("./db/client.js");
const { registerRoutes } = await import("./routes.js");

const app: FastifyInstance = Fastify();
await registerRoutes(app);
after(async () => {
  await app.close();
  await sql.end({ timeout: 0 });
});

test("an unknown view or a bad doneSince is a 400", async () => {
  for (const url of ["/tasks?view=full", "/tasks?doneSince=yesterday", "/tasks?doneSince="]) {
    const res = await app.inject({ url });
    assert.equal(res.statusCode, 400, url);
  }
});

describe("against a real database", { skip: adminUrl ? false : "PINBOARD_TEST_DATABASE_URL unset" }, () => {
  let admin: ReturnType<typeof postgres>;
  let projectA: number;
  let projectB: number;
  const ids: Record<string, number> = {};

  before(async () => {
    admin = postgres(adminUrl!, { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.unsafe(`CREATE DATABASE ${scratchDb}`);
    const conn = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
    await conn.end({ timeout: 0 });

    const create = async (path: string, payload: Record<string, unknown>) => {
      const res = await app.inject({ method: "POST", url: path, payload });
      assert.equal(res.statusCode, 201, res.body);
      return res.json().id as number;
    };
    projectA = await create("/projects", { slug: "a", name: "A" });
    projectB = await create("/projects", { slug: "b", name: "B" });
    ids.story = await create("/tasks", { projectId: projectA, title: "Story", taskType: "story", description: "the long story text" });
    ids.child = await create("/tasks", { projectId: projectA, title: "Child", status: "review", description: "kangaroo detail" });
    ids.oldDone = await create("/tasks", { projectId: projectA, title: "Old done", status: "done" });
    ids.newDone = await create("/tasks", { projectId: projectB, title: "New done", status: "done" });
    ids.idea = await create("/tasks", { projectId: projectB, title: "Idea" });
    const rel = await app.inject({ method: "POST", url: `/tasks/${ids.child}/relations`, payload: { toTaskId: ids.story, relationType: "parent" } });
    assert.equal(rel.statusCode, 201, rel.body);
    await sql`UPDATE tasks SET updated_at = '2026-01-01T00:00:00Z' WHERE id = ${ids.oldDone}`;
    await sql`UPDATE tasks SET updated_at = '2026-03-01T00:00:00Z' WHERE id = ${ids.newDone}`;
  });

  after(async () => {
    await sql.end({ timeout: 0 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.end({ timeout: 0 });
  });

  test("view=summary drops the long text and root-grant fields and keeps what the lists read", async () => {
    const full = (await app.inject({ url: "/tasks" })).json();
    const summary = (await app.inject({ url: "/tasks?view=summary" })).json();
    assert.deepEqual(
      summary.map((t: { id: number }) => t.id),
      full.map((t: { id: number }) => t.id),
    );
    const dropped = ["description", "repairReason", "repairContext", "rootScope", "rootGrantCtids", "rootGrantExpiresAt", "rootGrantedAt", "rootGrantedBy"];
    for (const key of dropped) {
      assert.ok(key in full[0], `the full row has ${key}`);
      assert.ok(!(key in summary[0]), `the summary row has no ${key}`);
    }
    const child = summary.find((t: { id: number }) => t.id === ids.child);
    for (const key of ["id", "projectId", "title", "taskType", "status", "executorMode", "priority", "estimatedEffort", "attemptCount", "leaseExpiresAt", "controlAction", "updatedAt", "effectiveReasoningEffort"]) {
      assert.ok(key in child, `the summary row keeps ${key}`);
    }
    assert.equal(child.parentTaskId, ids.story);
  });

  test("view=summary combines with q, which still searches the description", async () => {
    const hits = (await app.inject({ url: "/tasks?view=summary&q=kangaroo" })).json();
    assert.deepEqual(hits.map((t: { id: number }) => t.id), [ids.child]);
    const byId = (await app.inject({ url: `/tasks?view=summary&q=%23${ids.idea}` })).json();
    assert.deepEqual(byId.map((t: { id: number }) => t.id), [ids.idea]);
  });

  test("doneSince lists only done tasks updated after it", async () => {
    const recent = (await app.inject({ url: "/tasks?doneSince=2026-02-01T00:00:00.000Z" })).json();
    assert.deepEqual(recent.map((t: { id: number }) => t.id), [ids.newDone]);
    const all = (await app.inject({ url: "/tasks?view=summary&doneSince=2025-12-01T00:00:00Z" })).json();
    assert.deepEqual(all.map((t: { id: number }) => t.id).sort(), [ids.oldDone, ids.newDone].sort());
  });

  test("GET /tasks/counts counts by status and project", async () => {
    const res = await app.inject({ url: "/tasks/counts" });
    assert.equal(res.statusCode, 200);
    const counts = res.json() as { status: string; projectId: number; count: number }[];
    const sorted = counts.sort((a, b) => a.projectId - b.projectId || a.status.localeCompare(b.status));
    assert.deepEqual(sorted, [
      { status: "done", projectId: projectA, count: 1 },
      { status: "idea", projectId: projectA, count: 1 },
      { status: "review", projectId: projectA, count: 1 },
      { status: "done", projectId: projectB, count: 1 },
      { status: "idea", projectId: projectB, count: 1 },
    ]);
  });

  test("GET /tasks/:id carries parentTaskId", async () => {
    assert.equal((await app.inject({ url: `/tasks/${ids.child}` })).json().parentTaskId, ids.story);
    assert.equal((await app.inject({ url: `/tasks/${ids.story}` })).json().parentTaskId, null);
  });
});
