import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import postgres from "postgres";
import { TASK_STATUSES } from "./task-model.js";

// The status model change against a real Postgres: migration 0049 on a
// database holding every removed status, and the exact calls a foreman that
// predates the change makes, so pinboard can deploy before or after it. Set
// PINBOARD_TEST_DATABASE_URL to a server the test may create and drop a
// scratch database on; without it the whole file is skipped.
const adminUrl = process.env.PINBOARD_TEST_DATABASE_URL;
const scratchDb = `pinboard_status_model_${process.pid}`;
if (adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = `/${scratchDb}`;
  process.env.DATABASE_URL = url.toString();
}

const { sql } = await import("./db/client.js");
const { registerRoutes } = await import("./routes.js");

const app: FastifyInstance = Fastify();
await registerRoutes(app);

const agent = { actorType: "agent", actorName: "foreman-runner" };
const poller = { actorType: "agent", actorName: "foreman-pipeline" };

describe("status model against a real database", { skip: adminUrl ? false : "PINBOARD_TEST_DATABASE_URL unset" }, () => {
  let admin: ReturnType<typeof postgres>;
  let projectId: number;

  before(async () => {
    admin = postgres(adminUrl!, { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.unsafe(`CREATE DATABASE ${scratchDb}`);
  });

  after(async () => {
    await sql.end({ timeout: 0 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.end({ timeout: 0 });
  });

  test("migration 0049 leaves only the current statuses", async () => {
    const previous = await mkdtemp(join(tmpdir(), "pinboard-migrations-"));
    try {
      await cp("drizzle", previous, { recursive: true });
      const journalPath = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      const index = journal.entries.findIndex((e: { tag: string }) => e.tag.endsWith("_task_status_model"));
      assert.ok(index > 0, "the status model migration is in the journal");
      journal.entries = journal.entries.slice(0, index);
      await writeFile(journalPath, JSON.stringify(journal));

      const conn = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        await migrate(drizzle(conn), { migrationsFolder: previous });
        const [p] = await conn`INSERT INTO projects (slug, name) VALUES ('old', 'Old') RETURNING id`;
        projectId = p.id;
        const old = ["planned", "todo", "backlog", "executing", "awaiting_review", "handoff", "decomposed", "queued", "review", "awaiting_ci"];
        for (const status of old) {
          await conn`INSERT INTO tasks (project_id, title, status, pipeline_stage_entered_at)
            VALUES (${projectId}, ${status}, ${status}, ${status.startsWith("awaiting") ? conn`now()` : null})`;
        }

        await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
        const rows = await conn<{ title: string; status: string; review_reason: string | null; pipeline_stage_entered_at: Date | null }[]>`
          SELECT title, status, review_reason, pipeline_stage_entered_at FROM tasks`;
        const by = Object.fromEntries(rows.map((r) => [r.title, r]));
        assert.deepEqual(
          Object.fromEntries(rows.map((r) => [r.title, r.status])),
          {
            planned: "defined",
            todo: "defined",
            backlog: "defined",
            executing: "in_progress",
            awaiting_review: "review",
            handoff: "rework",
            decomposed: "defined",
            queued: "queued",
            review: "review",
            awaiting_ci: "awaiting_ci",
          },
        );
        assert.equal(by.awaiting_review.review_reason, "migration");
        assert.equal(by.awaiting_review.pipeline_stage_entered_at, null);
        assert.equal(by.review.review_reason, null);
        assert.ok(by.awaiting_ci.pipeline_stage_entered_at, "a real pipeline stage keeps its clock");

        const statuses = await conn<{ status: string }[]>`SELECT DISTINCT status FROM tasks`;
        for (const { status } of statuses) assert.ok((TASK_STATUSES as readonly string[]).includes(status), status);

        const notes = await conn`
          SELECT c.body, e.payload FROM comments c
          JOIN tasks t ON t.id = c.task_id
          JOIN task_events e ON e.task_id = t.id AND e.event_type = 'status'
          WHERE t.title = 'handoff'`;
        assert.equal(notes.length, 1);
        assert.match(notes[0].body, /handoff is no longer a status/);
        assert.deepEqual({ from: notes[0].payload.from, to: notes[0].payload.to }, { from: "handoff", to: "rework" });
      } finally {
        await conn.end({ timeout: 0 });
      }
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
  });

  const newTask = async (title: string, executorMode = "agent"): Promise<number> => {
    const [row] = await sql<{ id: number }[]>`
      INSERT INTO tasks (project_id, title, status, executor_mode) VALUES (${projectId}, ${title}, 'queued', ${executorMode}) RETURNING id`;
    return row.id;
  };
  const status = async (id: number) => {
    const [row] = await sql<{ status: string; review_reason: string | null }[]>`SELECT status, review_reason FROM tasks WHERE id = ${id}`;
    return row;
  };
  const advance = async (id: number, to: string, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({ method: "POST", url: `/tasks/${id}/pipeline`, payload: { ...poller, to, ...extra } });
    assert.equal(res.statusCode, 200, `-> ${to}: ${res.body}`);
    return res.json();
  };

  // Each call below is one foreman makes today (runner.ts's claim, handoff
  // and advancePipeline; pipeline.ts's decideAfterCi/decideAfterMerge/
  // decideAfterVerify targets), in the order a run makes them.
  test("an older foreman's run still lands: claim, handoff, CI hold, approve, merge with nothing to deploy", async () => {
    const id = await newTask("held migration");
    const claim = await app.inject({ method: "POST", url: `/tasks/${id}/claim`, payload: { ...agent, leaseSeconds: 600 } });
    assert.equal(claim.statusCode, 200, claim.body);
    assert.equal(claim.json().status, "in_progress");

    // the old runner's resume check reads GET /tasks?status=executing style filters too
    const listed = await app.inject({ url: `/tasks?status=executing&projectId=${projectId}` });
    assert.ok(listed.json().some((t: { id: number }) => t.id === id), "executing filters on in_progress");

    const handoff = await app.inject({ method: "POST", url: `/tasks/${id}/handoff`, payload: { ...agent, completed: "did it", costUsd: "0.5" } });
    assert.equal(handoff.statusCode, 201, handoff.body);
    assert.equal((await status(id)).status, "in_progress", "a handoff does not move the task");

    await advance(id, "awaiting_ci");
    // old foreman's migration hold
    const held = await advance(id, "awaiting_review");
    assert.equal(held.status, "review");
    assert.equal(held.reviewReason, "migration");
    assert.equal(held.pipelineStageEnteredAt, null);

    // the review queue's Approve & merge
    const approved = await app.inject({ method: "POST", url: `/tasks/${id}/pipeline`, payload: { actorType: "human", actorName: "op", to: "awaiting_merge" } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().reviewReason, null);

    // old foreman: merged, nothing to deploy -> review, which is done now
    const merged = await advance(id, "review");
    assert.equal(merged.status, "done");
    const [complete] = await sql`SELECT 1 FROM task_events WHERE task_id = ${id} AND event_type = 'complete'`;
    assert.ok(complete, "closing through the pipeline records a completion");
  });

  test("an older foreman's post-deploy review on a human+agent task is done", async () => {
    const id = await newTask("deployed", "human+agent");
    await app.inject({ method: "POST", url: `/tasks/${id}/claim`, payload: { ...agent, leaseSeconds: 600 } });
    for (const to of ["awaiting_ci", "awaiting_merge", "deploying", "verifying"]) await advance(id, to);
    assert.equal((await advance(id, "review")).status, "done");
  });

  test("a newer foreman's moves: review with a reason, done after verify and after a no-deploy merge", async () => {
    const id = await newTask("no auto-deploy");
    await app.inject({ method: "POST", url: `/tasks/${id}/claim`, payload: { ...agent, leaseSeconds: 600 } });
    await advance(id, "awaiting_ci");
    const review = await advance(id, "review", { reviewReason: "no_auto_deploy" });
    assert.deepEqual({ s: review.status, r: review.reviewReason }, { s: "review", r: "no_auto_deploy" });
    const bad = await app.inject({ method: "POST", url: `/tasks/${id}/pipeline`, payload: { ...poller, to: "awaiting_merge", reviewReason: "nope" } });
    assert.equal(bad.statusCode, 400);

    // pulled out by hand: the reason goes with the stay in review
    const pulled = await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { actorType: "human", actorName: "op", status: "rework" } });
    assert.equal(pulled.json().reviewReason, null);

    const other = await newTask("library");
    await app.inject({ method: "POST", url: `/tasks/${other}/claim`, payload: { ...agent, leaseSeconds: 600 } });
    for (const to of ["awaiting_ci", "awaiting_merge"]) await advance(other, to);
    assert.equal((await advance(other, "done")).status, "done");
  });

  test("the concurrency snapshot counts in_progress tasks an agent run holds, not human claims", async () => {
    const { getExecutingSnapshot } = await import("./governor.js");
    const byAgent = await newTask("agent run", "human+agent");
    const byHuman = await newTask("by hand", "human+agent");
    await app.inject({ method: "POST", url: `/tasks/${byAgent}/claim`, payload: { ...agent, leaseSeconds: 600 } });
    const human = await app.inject({ method: "POST", url: `/tasks/${byHuman}/claim`, payload: { actorType: "human", actorName: "op" } });
    assert.equal(human.json().status, "in_progress");
    // even a lease does not make a person's claim an agent run
    await sql`UPDATE tasks SET lease_expires_at = now() + interval '10 minutes' WHERE id = ${byHuman}`;
    const ids = (await getExecutingSnapshot()).map((t) => t.taskId);
    assert.ok(ids.includes(byAgent));
    assert.ok(!ids.includes(byHuman));
  });

  test("old status names are accepted on PATCH and POST", async () => {
    const id = await newTask("aliases");
    for (const [sent, stored] of [["planned", "defined"], ["executing", "in_progress"], ["awaiting_review", "review"], ["todo", "defined"]]) {
      const res = await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { status: sent } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().status, stored, sent);
    }
    const handoff = await app.inject({ method: "PATCH", url: `/tasks/${id}`, payload: { status: "handoff" } });
    assert.equal(handoff.statusCode, 400);
    const created = await app.inject({ method: "POST", url: "/tasks", payload: { projectId, title: "planned one", status: "planned" } });
    assert.equal(created.json().status, "defined");
  });
});
