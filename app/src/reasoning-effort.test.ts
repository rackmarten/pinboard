import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import postgres from "postgres";
import { effectiveReasoningEffort, isReasoningEffort } from "./task-model.js";

// The database-backed tests below need a real Postgres: set
// PINBOARD_TEST_DATABASE_URL to a server the test may create and drop a
// scratch database on (e.g. postgresql://test:test@localhost:5433/postgres).
// Without it only the validation and fallback tests run, since validation
// rejects a bad value before any query.
const adminUrl = process.env.PINBOARD_TEST_DATABASE_URL;
const scratchDb = `pinboard_reasoning_effort_${process.pid}`;
if (adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = `/${scratchDb}`;
  process.env.DATABASE_URL = url.toString();
}

// imported after DATABASE_URL is settled, since the db client reads it once.
const { sql } = await import("./db/client.js");
const { registerRoutes } = await import("./routes.js");

const app: FastifyInstance = Fastify();
await registerRoutes(app);
after(async () => {
  await app.close();
  await sql.end({ timeout: 0 });
});

test("isReasoningEffort accepts medium and high only", () => {
  assert.equal(isReasoningEffort("medium"), true);
  assert.equal(isReasoningEffort("high"), true);
  for (const v of ["low", "max", "", null, undefined, 3]) assert.equal(isReasoningEffort(v), false);
});

test("effectiveReasoningEffort: the task's own value, else the project default, else null", () => {
  assert.equal(effectiveReasoningEffort("medium", "high"), "medium");
  assert.equal(effectiveReasoningEffort(null, "high"), "high");
  assert.equal(effectiveReasoningEffort(null, null), null);
  assert.equal(effectiveReasoningEffort(null, undefined), null);
});

test("a bad reasoning effort is a 400 on task and project create and PATCH", async () => {
  const cases = [
    { method: "POST" as const, url: "/tasks", payload: { projectId: 1, title: "t", reasoningEffort: "max" } },
    { method: "PATCH" as const, url: "/tasks/1", payload: { reasoningEffort: "low" } },
    { method: "POST" as const, url: "/projects", payload: { slug: "p", name: "P", defaultReasoningEffort: 1 } },
    { method: "PATCH" as const, url: "/projects/1", payload: { defaultReasoningEffort: "" } },
  ];
  for (const c of cases) {
    const res = await app.inject(c);
    assert.equal(res.statusCode, 400, `${c.method} ${c.url}`);
    assert.match(res.json().message, /easoningEffort must be one of medium, high or null/);
  }
});

describe("against a real database", { skip: adminUrl ? false : "PINBOARD_TEST_DATABASE_URL unset" }, () => {
  let admin: ReturnType<typeof postgres>;
  let projectId: number;
  let taskId: number;

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

  test("the migration applies cleanly on a database with existing projects and tasks", async () => {
    // an "existing" database: every migration before this one, with data in it.
    const previous = await mkdtemp(join(tmpdir(), "pinboard-migrations-"));
    try {
      await cp("drizzle", previous, { recursive: true });
      const journalPath = join(previous, "meta", "_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      const index = journal.entries.findIndex((e: { tag: string }) => e.tag.endsWith("_task_reasoning_effort"));
      assert.ok(index > 0, "the reasoning-effort migration is in the journal");
      journal.entries = journal.entries.slice(0, index);
      await writeFile(journalPath, JSON.stringify(journal));

      const conn = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
      try {
        await migrate(drizzle(conn), { migrationsFolder: previous });
        const [p] = await conn`INSERT INTO projects (slug, name) VALUES ('existing', 'Existing') RETURNING id`;
        await conn`INSERT INTO tasks (project_id, title) VALUES (${p.id}, 'existing task')`;

        await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
        const [row] = await conn`
          SELECT t.reasoning_effort, p.default_reasoning_effort
          FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'existing'`;
        assert.deepEqual({ ...row }, { reasoning_effort: null, default_reasoning_effort: null });
      } finally {
        await conn.end({ timeout: 0 });
      }
    } finally {
      await rm(previous, { recursive: true, force: true });
    }
  });

  test("both fields are stored and returned, and a task inherits the project default", async () => {
    const project = await app.inject({ method: "POST", url: "/projects", payload: { slug: "effort", name: "Effort" } });
    assert.equal(project.statusCode, 201);
    assert.equal(project.json().defaultReasoningEffort, null);
    projectId = project.json().id;

    const task = await app.inject({ method: "POST", url: "/tasks", payload: { projectId, title: "inherits" } });
    assert.equal(task.statusCode, 201);
    assert.equal(task.json().reasoningEffort, null);
    assert.equal(task.json().effectiveReasoningEffort, null);
    taskId = task.json().id;

    const patched = await app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { defaultReasoningEffort: "high" } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().defaultReasoningEffort, "high");
    assert.equal((await app.inject({ url: `/projects/${projectId}` })).json().defaultReasoningEffort, "high");

    const read = (await app.inject({ url: `/tasks/${taskId}` })).json();
    assert.equal(read.reasoningEffort, null);
    assert.equal(read.effectiveReasoningEffort, "high");
    const listed = (await app.inject({ url: `/tasks?projectId=${projectId}` })).json();
    assert.equal(listed[0].effectiveReasoningEffort, "high");
  });

  test("a task's own value wins, and null clears it back to the project default", async () => {
    const set = await app.inject({ method: "PATCH", url: `/tasks/${taskId}`, payload: { reasoningEffort: "medium" } });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().reasoningEffort, "medium");
    assert.equal(set.json().effectiveReasoningEffort, "medium");

    const cleared = await app.inject({ method: "PATCH", url: `/tasks/${taskId}`, payload: { reasoningEffort: null } });
    assert.equal(cleared.json().reasoningEffort, null);
    assert.equal(cleared.json().effectiveReasoningEffort, "high");

    const projectCleared = await app.inject({ method: "PATCH", url: `/projects/${projectId}`, payload: { defaultReasoningEffort: null } });
    assert.equal(projectCleared.json().defaultReasoningEffort, null);
    assert.equal((await app.inject({ url: `/tasks/${taskId}` })).json().effectiveReasoningEffort, null);

    const created = await app.inject({ method: "POST", url: "/tasks", payload: { projectId, title: "own", reasoningEffort: "high" } });
    assert.equal(created.json().reasoningEffort, "high");
    assert.equal(created.json().effectiveReasoningEffort, "high");
  });
});
