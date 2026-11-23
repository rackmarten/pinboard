import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import Fastify, { type FastifyInstance } from "fastify";
import postgres from "postgres";

// POST /session-links and GET /now. The database-backed tests need
// PINBOARD_TEST_DATABASE_URL, as in task-list-views.test.ts; without it only
// the validation and pure-assembly tests run.
const adminUrl = process.env.PINBOARD_TEST_DATABASE_URL;
const scratchDb = `pinboard_now_${process.pid}`;
if (adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = `/${scratchDb}`;
  process.env.DATABASE_URL = url.toString();
}

const { sql } = await import("./db/client.js");
const { registerRoutes } = await import("./routes.js");
const { buildFinishedSessions, buildNowStories } = await import("./now.js");
type NowTask = import("./now.js").NowTask;

const app: FastifyInstance = Fastify();
await registerRoutes(app);
after(async () => {
  await app.close();
  await sql.end({ timeout: 0 });
});

for (const [name, payload] of [
  ["an empty sessionId", { sessionId: "", taskIds: [1] }],
  ["a missing taskIds", { sessionId: "s1" }],
  ["a non-integer task id", { sessionId: "s1", taskIds: [1.5] }],
  ["a zero task id", { sessionId: "s1", taskIds: [0] }],
  ["a string task id", { sessionId: "s1", taskIds: ["x"] }],
  ["a malformed at", { sessionId: "s1", taskIds: [1], at: "yesterday" }],
] as const) {
  test(`POST /session-links rejects ${name} with 400`, async () => {
    const res = await app.inject({ method: "POST", url: "/session-links", payload: payload as object });
    assert.equal(res.statusCode, 400, res.body);
  });
}

const now = new Date("2026-06-15T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
let nextId = 100;
const task = (fields: Partial<NowTask>): NowTask => ({
  id: nextId++,
  projectId: 1,
  title: "t",
  status: "defined",
  executorMode: "agent",
  priority: 0,
  createdAt: daysAgo(30),
  ...fields,
});
const project = { id: 1, slug: "p", name: "P" };

test("buildNowStories keeps stories with an active child or recent activity, waiting ones first", () => {
  const quiet = task({ title: "quiet", status: "defined" });
  const busy = task({ title: "busy", status: "decomposed" });
  const recent = task({ title: "recent", status: "defined" });
  const closed = task({ title: "closed", status: "done" });
  const busyChildren = [
    task({ title: "running", status: "in_progress" }),
    task({ title: "in review", status: "review" }),
    task({ title: "later", status: "queued", priority: 0, createdAt: daysAgo(1) }),
    task({ title: "first", status: "queued", priority: 0, createdAt: daysAgo(5) }),
    task({ title: "by hand", status: "defined", executorMode: "human" }),
    task({ title: "shipped", status: "done" }),
    task({ title: "dropped", status: "rejected" }),
  ];
  const quietChild = task({ status: "defined" });
  const stories = buildNowStories({
    now,
    stories: [quiet, busy, recent, closed],
    children: new Map([
      [busy.id, busyChildren],
      [quiet.id, [quietChild]],
      [closed.id, [task({ status: "queued" })]],
    ]),
    projects: new Map([[1, project]]),
    lastEventAt: new Map([
      [quiet.id, daysAgo(20)],
      [recent.id, daysAgo(2)],
      [busyChildren[0].id, daysAgo(3)],
    ]),
    openQuestions: [{ id: 7, taskId: busy.id, question: "which way?", createdAt: daysAgo(1) }],
    sessionLinks: [],
    interactiveCostBySession: new Map(),
  });
  assert.deepEqual(
    stories.map((s) => s.title),
    ["busy", "recent"],
  );
  const [b, r] = stories;
  assert.deepEqual(b.progress, { done: 1, total: 6 });
  assert.deepEqual(b.running, [{ id: busyChildren[0].id, title: "running", status: "in_progress" }]);
  assert.deepEqual(b.next, { id: busyChildren[3].id, title: "first" });
  assert.deepEqual(
    b.waiting.map((w) => [w.kind, w.taskId]),
    [
      ["ask", busy.id],
      ["review", busyChildren[1].id],
      ["human", busyChildren[4].id],
    ],
  );
  assert.equal(b.waiting[0].kind === "ask" && b.waiting[0].askId, 7);
  assert.equal(b.lastActivityAt, daysAgo(3).toISOString());
  assert.deepEqual(r.waiting, []);
  assert.equal(r.next, null);
  assert.deepEqual(r.progress, { done: 0, total: 0 });
});

test("buildNowStories sums each linked session's interactive spend once and lists the last three sessions", () => {
  const story = task({ status: "defined" });
  const child = task({ status: "queued" });
  const links = [
    { sessionId: "a", taskId: story.id, cwd: "/a", lastSeenAt: daysAgo(4) },
    { sessionId: "a", taskId: child.id, cwd: "/a2", lastSeenAt: daysAgo(1) },
    { sessionId: "b", taskId: child.id, cwd: null, lastSeenAt: daysAgo(2) },
    { sessionId: "c", taskId: story.id, cwd: "/c", lastSeenAt: daysAgo(3) },
    { sessionId: "d", taskId: story.id, cwd: "/d", lastSeenAt: daysAgo(9) },
    { sessionId: "elsewhere", taskId: 9999, cwd: null, lastSeenAt: daysAgo(0) },
  ];
  const [s] = buildNowStories({
    now,
    stories: [story],
    children: new Map([[story.id, [child]]]),
    projects: new Map([[1, project]]),
    lastEventAt: new Map(),
    openQuestions: [],
    sessionLinks: links,
    interactiveCostBySession: new Map([
      ["a", 1.5],
      ["b", 0.25],
      ["d", 2],
      ["elsewhere", 100],
    ]),
  });
  assert.deepEqual(s.sessions, [
    { sessionId: "a", cwd: "/a2", lastSeenAt: daysAgo(1).toISOString() },
    { sessionId: "b", cwd: null, lastSeenAt: daysAgo(2).toISOString() },
    { sessionId: "c", cwd: "/c", lastSeenAt: daysAgo(3).toISOString() },
  ]);
  assert.equal(s.interactiveCostUsd, 3.75);
  assert.equal(s.lastActivityAt, daysAgo(1).toISOString());
});

test("buildFinishedSessions keeps sessions whose every linked task belongs to a closed story", () => {
  const t = (id: number, status: string, taskType = "implementation") => [id, { id, title: `#${id}`, status, taskType }] as const;
  const linked = new Map([t(1, "done", "story"), t(2, "done"), t(3, "defined", "story"), t(4, "done"), t(5, "rejected"), t(6, "queued")]);
  const parentOf = new Map([
    [2, 1],
    [4, 3],
  ]);
  const link = (sessionId: string, taskId: number, d: number) => ({ sessionId, taskId, cwd: `/${sessionId}`, lastSeenAt: daysAgo(d) });
  const finished = buildFinishedSessions(
    [
      link("closed-story", 1, 3),
      link("closed-story", 2, 2), // child of the done story
      link("open-story", 4, 1), // a done child of an open story keeps it open
      link("standalone", 5, 1),
      link("mixed", 5, 0),
      link("mixed", 6, 0),
      link("unknown", 404, 0),
    ],
    linked,
    parentOf,
  );
  assert.deepEqual(finished, [
    { sessionId: "standalone", cwd: "/standalone", lastSeenAt: daysAgo(1).toISOString(), stories: [{ id: 5, title: "#5", status: "rejected" }] },
    { sessionId: "closed-story", cwd: "/closed-story", lastSeenAt: daysAgo(2).toISOString(), stories: [{ id: 1, title: "#1", status: "done" }] },
  ]);
});

describe("against a real database", { skip: adminUrl ? false : "PINBOARD_TEST_DATABASE_URL unset" }, () => {
  let admin: ReturnType<typeof postgres>;
  const ids: Record<string, number> = {};

  const create = async (path: string, payload: Record<string, unknown>) => {
    const res = await app.inject({ method: "POST", url: path, payload });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().id as number;
  };
  const link = async (payload: Record<string, unknown>) => {
    const res = await app.inject({ method: "POST", url: "/session-links", payload });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { linked: number };
  };

  before(async () => {
    admin = postgres(adminUrl!, { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.unsafe(`CREATE DATABASE ${scratchDb}`);
    const conn = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    await migrate(drizzle(conn), { migrationsFolder: "drizzle" });
    await conn.end({ timeout: 0 });

    ids.project = await create("/projects", { slug: "demo", name: "Demo" });
    ids.story = await create("/tasks", { projectId: ids.project, title: "Story", taskType: "story", status: "decomposed" });
    ids.child = await create("/tasks", { projectId: ids.project, title: "Child", executorMode: "agent" });
    ids.review = await create("/tasks", { projectId: ids.project, title: "Review me", status: "review" });
    ids.doneStory = await create("/tasks", { projectId: ids.project, title: "Done story", taskType: "story", status: "done" });
    for (const child of [ids.child, ids.review]) {
      const rel = await app.inject({ method: "POST", url: `/tasks/${child}/relations`, payload: { toTaskId: ids.story, relationType: "parent" } });
      assert.equal(rel.statusCode, 201, rel.body);
    }
    // straight to queued, past the readiness gate POST /tasks applies
    await sql`UPDATE tasks SET status = 'queued' WHERE id = ${ids.child}`;
    await sql`INSERT INTO licenses (name, provider, linux_user) VALUES ('now-test', 'anthropic', 'nowtester')`;
  });

  after(async () => {
    await sql.end({ timeout: 0 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchDb}`);
    await admin.end({ timeout: 0 });
  });

  test("POST /session-links upserts per (session, task), skips unknown ids and widens the seen window", async () => {
    assert.deepEqual(await link({ sessionId: "s1", cwd: "/work/one", taskIds: [ids.story, ids.child, ids.child, 99999], at: "2026-06-10T10:00:00Z" }), { linked: 2 });
    assert.deepEqual(await link({ sessionId: "s1", taskIds: [ids.child], at: "2026-06-09T10:00:00Z" }), { linked: 1 });
    assert.deepEqual(await link({ sessionId: "s1", cwd: "/work/two", taskIds: [ids.child], at: "2026-06-11T10:00:00Z" }), { linked: 1 });
    assert.deepEqual(await link({ sessionId: "s1", taskIds: [99999] }), { linked: 0 });
    const rows = await sql`SELECT task_id, cwd, first_seen_at, last_seen_at FROM session_links WHERE session_id = 's1' ORDER BY task_id`;
    assert.equal(rows.length, 2);
    const child = rows.find((r) => r.task_id === ids.child)!;
    assert.equal(child.cwd, "/work/two");
    assert.equal(new Date(child.first_seen_at).toISOString(), "2026-06-09T10:00:00.000Z");
    assert.equal(new Date(child.last_seen_at).toISOString(), "2026-06-11T10:00:00.000Z");
    const story = rows.find((r) => r.task_id === ids.story)!;
    assert.equal(story.cwd, "/work/one");
  });

  test("GET /now lists the active story with progress, waiting, next, sessions, spend and finished sessions", async () => {
    await link({ sessionId: "s2", cwd: "/work/three", taskIds: [ids.review] });
    await link({ sessionId: "s3", cwd: "/work/four", taskIds: [ids.doneStory] });
    // Last seen long before the finished-sessions window: left out.
    await link({ sessionId: "s-old", cwd: "/work/old", taskIds: [ids.doneStory], at: "2020-01-01T00:00:00Z" });
    for (const [sessionId, costUsd] of [["s1", 0.5], ["s2", 1.25], ["s1", 0.25], ["s3", 9]] as const) {
      const res = await app.inject({ method: "POST", url: "/usage", payload: { costUsd, source: "interactive", linuxUser: "nowtester", sessionId } });
      assert.equal(res.statusCode, 201, res.body);
    }
    await sql`INSERT INTO task_asks (task_id, kind, question) VALUES (${ids.child}, 'question', 'Which colour?'), (${ids.child}, 'assumption', 'Went with blue')`;

    const res = await app.inject({ url: "/now" });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
    assert.equal(body.stories.length, 1);
    const [s] = body.stories;
    assert.equal(s.id, ids.story);
    assert.equal(s.status, "decomposed");
    assert.deepEqual(s.project, { id: ids.project, slug: "demo", name: "Demo" });
    assert.deepEqual(s.progress, { done: 0, total: 2 });
    assert.deepEqual(s.running, []);
    assert.deepEqual(s.next, { id: ids.child, title: "Child" });
    assert.deepEqual(
      s.waiting.map((w: { kind: string; taskId: number; question?: string }) => [w.kind, w.taskId, w.question]),
      [
        ["ask", ids.child, "Which colour?"],
        ["review", ids.review, undefined],
      ],
    );
    assert.deepEqual(
      s.sessions.map((x: { sessionId: string; cwd: string }) => [x.sessionId, x.cwd]),
      [
        ["s2", "/work/three"],
        ["s1", "/work/two"],
      ],
    );
    assert.equal(s.interactiveCostUsd, 2);
    assert.ok(s.lastActivityAt);
    assert.deepEqual(
      body.finishedSessions.map((f: { sessionId: string; stories: { id: number }[] }) => [f.sessionId, f.stories.map((x) => x.id)]),
      [["s3", [ids.doneStory]]],
    );
  });
});
