import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { sql } from "./db/client.js";
import {
  normalizeBatch,
  registerActivityRoutes,
  statusIntervals,
  summarizeActivity,
  waitingIntervals,
  waitStat,
  weeklyWaiting,
  weekStart,
  type ActivityEntry,
  type ActivityStore,
  type JournalStatusEvent,
  type MinuteRow,
} from "./activity.js";

after(async () => {
  await sql.end({ timeout: 0 });
});

const now = new Date(2026, 10, 7, 12, 30, 15); // Sat 2026-11-07 12:30 local
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);

// --- normalizeBatch ----------------------------------------------------------

test("normalizeBatch truncates to the minute and folds duplicate keys", () => {
  const minute = new Date(2026, 10, 7, 12, 29, 40).toISOString();
  const out = normalizeBatch(
    {
      entries: [
        { kind: "active", minute, route: "/tasks/:id", name: "review", value: 40 },
        { kind: "active", minute, route: "/tasks/:id", name: "review", value: 40 },
        { kind: "click", minute, route: "/tasks/:id", name: "approve", value: 1 },
        { kind: "click", minute, route: "/tasks/:id", name: "approve", value: 2 },
      ],
    },
    now,
  );
  assert.equal(out.length, 2);
  const active = out.find((e) => e.kind === "active")!;
  assert.equal(active.value, 60, "a minute never holds more than 60 active seconds");
  assert.equal(active.minute.getSeconds(), 0);
  assert.equal(out.find((e) => e.kind === "click")!.value, 3);
});

test("normalizeBatch drops entries outside the time window instead of failing", () => {
  const out = normalizeBatch(
    {
      entries: [
        { kind: "click", minute: at(1, 0).toISOString(), route: "/", name: "x", value: 1 }, // 6 days back: kept
        { kind: "click", minute: at(7, 12, 50).toISOString(), route: "/", name: "x", value: 1 }, // 20 min ahead
        { kind: "click", minute: new Date(2026, 9, 1).toISOString(), route: "/", name: "x", value: 1 }, // a month back
      ],
    },
    now,
  );
  assert.equal(out.length, 1);
});

for (const [name, entry] of [
  ["an unknown kind", { kind: "scroll", minute: now.toISOString(), route: "/", name: "x", value: 1 }],
  ["an empty route", { kind: "click", minute: now.toISOString(), route: "", name: "x", value: 1 }],
  ["more than 60 active seconds", { kind: "active", minute: now.toISOString(), route: "/", name: "x", value: 61 }],
  ["a zero value", { kind: "click", minute: now.toISOString(), route: "/", name: "x", value: 0 }],
  ["a bad timestamp", { kind: "click", minute: "yesterday-ish", route: "/", name: "x", value: 1 }],
] as const) {
  test(`normalizeBatch rejects ${name}`, () => {
    assert.throws(() => normalizeBatch({ entries: [entry] }, now));
  });
}

test("normalizeBatch rejects a body without an entries array", () => {
  assert.throws(() => normalizeBatch({}, now));
  assert.throws(() => normalizeBatch(null, now));
});

// --- summarizeActivity -------------------------------------------------------

test("summarizeActivity totals active minutes per day and ranks modules and features", () => {
  const rows: MinuteRow[] = [
    { minute: at(7, 9, 0), kind: "active", route: "/inbox", name: "inbox", value: 60 },
    { minute: at(7, 9, 1), kind: "active", route: "/inbox", name: "inbox", value: 30 },
    { minute: at(6, 22, 0), kind: "active", route: "/tasks/:id", name: "review", value: 60 },
    { minute: at(6, 22, 1), kind: "active", route: "/tasks/:id", name: "review", value: 60 },
    { minute: at(6, 22, 2), kind: "active", route: "/tasks/:id", name: "review", value: 60 },
    { minute: at(6, 22, 0), kind: "click", route: "/tasks/:id", name: "approve", value: 2 },
    { minute: at(7, 9, 0), kind: "click", route: "/inbox", name: "answer-ask", value: 5 },
    { minute: at(7, 9, 1), kind: "click", route: "/tasks/:id", name: "approve", value: 1 },
    // before the 3-day range: ignored
    { minute: at(1, 9, 0), kind: "active", route: "/", name: "dashboard", value: 60 },
  ];
  const s = summarizeActivity(rows, now, 3);
  assert.deepEqual(
    s.daily.map((d) => [d.day, d.activeMinutes]),
    [
      ["2026-11-05", 0],
      ["2026-11-06", 3],
      ["2026-11-07", 1.5],
    ],
  );
  assert.equal(s.totalActiveMinutes, 4.5);
  assert.deepEqual(s.modules[0], { route: "/tasks/:id", module: "review", activeMinutes: 3 });
  assert.deepEqual(s.modules[1], { route: "/inbox", module: "inbox", activeMinutes: 1.5 });
  assert.deepEqual(s.features, [
    { feature: "answer-ask", clicks: 5 },
    { feature: "approve", clicks: 3 },
  ]);
});

// --- waiting on a human ------------------------------------------------------

const ev = (taskId: number, when: Date, eventType: string, payload: Record<string, unknown> | null = null): JournalStatusEvent => ({
  taskId,
  at: when,
  eventType,
  payload,
});

test("statusIntervals pairs entering and leaving a status, including implied moves", () => {
  const events = [
    ev(1, at(2, 10), "status", { from: "queued", to: "review" }),
    ev(1, at(2, 14), "complete"), // review -> done after 4h
    ev(2, at(3, 8), "pipeline", { from: "verifying", to: "review" }),
    ev(2, at(3, 9), "comment"), // not a move
    ev(2, at(3, 10), "reject"), // review -> rework after 2h
    ev(3, at(4, 8), "status", { from: "review", to: "done" }), // entered before our window: skipped
    ev(4, at(4, 8), "status", { from: "verifying", to: "review" }), // still open: skipped
  ];
  const out = statusIntervals(events, "review");
  assert.deepEqual(
    out.map((i) => [i.taskId, (i.end.getTime() - i.start.getTime()) / 3600_000]),
    [
      [1, 4],
      [2, 2],
    ],
  );
});

test("statusIntervals treats a task created in a status as entering it", () => {
  const events = [ev(5, at(2, 9), "claim"), ev(5, at(2, 8), "created", { status: "queued" })];
  const out = statusIntervals(events, "queued");
  assert.equal(out.length, 1);
  assert.equal(out[0].end.getTime() - out[0].start.getTime(), 3600_000);
});

test("waitStat reports count, median and mean in hours", () => {
  assert.deepEqual(waitStat([]), { count: 0, medianHours: null, meanHours: null, totalHours: 0 });
  assert.deepEqual(waitStat([3600_000, 3 * 3600_000, 8 * 3600_000]), { count: 3, medianHours: 3, meanHours: 4, totalHours: 12 });
  assert.equal(waitStat([3600_000, 2 * 3600_000]).medianHours, 1.5);
});

test("weekStart is the Monday at local midnight", () => {
  const ws = weekStart(now);
  assert.equal(ws.getDay(), 1);
  assert.equal(ws.getDate(), 2);
  assert.equal(weekStart(at(2, 0, 0)).getDate(), 2);
  assert.equal(weekStart(new Date(2026, 10, 8, 23)).getDate(), 2, "Sunday still belongs to the week that began Monday");
});

test("waitingIntervals splits by executor and weeklyWaiting buckets by the week a wait ended", () => {
  const intervals = waitingIntervals({
    questions: [{ taskId: 10, createdAt: at(4, 10), answeredAt: at(4, 12) }], // this week, 2h
    executorModes: new Map([
      [20, "agent"],
      [21, "human"],
      [22, "human"],
    ]),
    events: [
      // agent task: defined for 5h last week
      ev(20, new Date(2026, 9, 27, 9), "created", { status: "defined" }),
      ev(20, new Date(2026, 9, 27, 14), "status", { from: "defined", to: "queued" }),
      // human task: defined is not counted for it, queued for 24h this week
      ev(21, at(3, 8), "created", { status: "defined" }),
      ev(21, at(3, 9), "status", { from: "defined", to: "queued" }),
      ev(21, at(4, 9), "claim"),
      // human task in review for 1h this week
      ev(22, at(5, 9), "status", { from: "executing", to: "review" }),
      ev(22, at(5, 10), "complete"),
    ],
  });
  assert.equal(intervals.defined.length, 1);
  assert.equal(intervals.humanQueued.length, 1);
  const weeks = weeklyWaiting(intervals, now, 2);
  assert.deepEqual(
    weeks.map((w) => w.weekStart),
    ["2026-10-26", "2026-11-02"],
  );
  assert.equal(weeks[0].defined.count, 1);
  assert.equal(weeks[0].defined.medianHours, 5);
  assert.equal(weeks[1].defined.count, 0);
  assert.equal(weeks[1].asks.medianHours, 2);
  assert.equal(weeks[1].humanQueued.medianHours, 24);
  assert.equal(weeks[1].review.medianHours, 1);
});

// --- routes --------------------------------------------------------------------

function fakeStore(enabled: Set<string>) {
  const recorded: { key: string; entries: ActivityEntry[] }[] = [];
  const store: ActivityStore = {
    async trackingEnabled(key) {
      return enabled.has(key);
    },
    async setTracking(key, on) {
      if (on) enabled.add(key);
      else enabled.delete(key);
    },
    async record(key, entries) {
      recorded.push({ key, entries });
    },
    async minutesSince() {
      return [{ minute: new Date(), kind: "active", route: "/usage", name: "usage", value: 60 }];
    },
    async waitingInputs() {
      return { questions: [], events: [], executorModes: new Map() };
    },
  };
  return { store, recorded };
}

async function appWith(store: ActivityStore) {
  const app = Fastify();
  await registerActivityRoutes(app, store);
  return app;
}

const batch = () => ({ entries: [{ kind: "click", minute: new Date().toISOString(), route: "/inbox", name: "approve", value: 1 }] });
const pwa = { "x-pinboard-client": "pwa" };

test("POST /activity records nothing while tracking is off", async () => {
  const { store, recorded } = fakeStore(new Set());
  const app = await appWith(store);
  const res = await app.inject({ method: "POST", url: "/activity", headers: pwa, payload: batch() });
  assert.equal(res.statusCode, 204);
  assert.equal(recorded.length, 0);
  await app.close();
});

test("POST /activity records under the requesting operator once opted in, beacon form included", async () => {
  const { store, recorded } = fakeStore(new Set());
  const app = await appWith(store);
  const put = await app.inject({ method: "PUT", url: "/me/settings", headers: pwa, payload: { usageTracking: true } });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.json(), { actor: "human:operator", usageTracking: true });
  // sendBeacon cannot set headers, so the client marker rides in the query
  const res = await app.inject({ method: "POST", url: "/activity?client=pwa", payload: batch() });
  assert.equal(res.statusCode, 204);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].key, "human:operator");
  await app.close();
});

test("a non-human caller can neither opt in nor record", async () => {
  const { store, recorded } = fakeStore(new Set(["system:api"]));
  const app = await appWith(store);
  const put = await app.inject({ method: "PUT", url: "/me/settings", payload: { usageTracking: true } });
  assert.equal(put.statusCode, 403);
  await app.inject({ method: "POST", url: "/activity", payload: batch() });
  assert.equal(recorded.length, 0);
  const get = await app.inject({ method: "GET", url: "/me/settings" });
  assert.equal(get.json().usageTracking, false);
  await app.close();
});

test("POST /activity rejects a malformed batch with 400", async () => {
  const { store } = fakeStore(new Set(["human:operator"]));
  const app = await appWith(store);
  const res = await app.inject({ method: "POST", url: "/activity", headers: pwa, payload: { entries: "lots" } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("GET /usage/my-time returns activity and weekly waiting figures", async () => {
  const { store } = fakeStore(new Set(["human:operator"]));
  const app = await appWith(store);
  const res = await app.inject({ method: "GET", url: "/usage/my-time?days=7&weeks=4", headers: pwa });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.usageTracking, true);
  assert.equal(body.activity.daily.length, 7);
  assert.equal(body.activity.totalActiveMinutes, 1);
  assert.equal(body.waiting.length, 4);
  await app.close();
});
