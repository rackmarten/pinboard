import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OVERLOAD_COVERAGE,
  UNDERLOAD_COVERAGE,
  computePace,
  loadVerdict,
  packPlan,
  rankRunnableTasks,
  slotTimeCapacity,
  startableNow,
  type RunnableTask,
} from "./plan.js";
import type { PlannedSlot } from "./session-windows.js";
import {
  RECURRENCE_NOTE,
  describeRecurrence,
  ensureRecurringPeriod,
  nextRecurringPeriod,
  validateRecurrencePatch,
  type RecurrenceSettings,
  type RecurrenceStore,
  type RecurrenceTx,
  type StoredPeriod,
} from "./recurrence.js";

const HOUR = 3_600_000;
const T0 = new Date("2026-09-16T10:00:00.000Z");

function task(overrides: Partial<RunnableTask> & { id: number }): RunnableTask {
  return {
    projectId: overrides.id,
    title: `task ${overrides.id}`,
    status: "queued",
    priority: 0,
    executorMode: "agent",
    autonomyLevel: 3,
    estimatedEffort: 3,
    createdAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

function slot(offsetHours: number, lengthHours = 5, hypothetical = true, spentUsd = 0): PlannedSlot {
  return {
    startsAt: new Date(T0.getTime() + offsetHours * HOUR),
    endsAt: new Date(T0.getTime() + (offsetHours + lengthHours) * HOUR),
    hypothetical,
    spentUsd,
  };
}

const flat = (costUsd: number) => () => ({ costUsd, basis: "global-mean" as const });

// --- ranking ---------------------------------------------------------------

test("ranking is priority desc then oldest first, unlike the human task list's newest-first", () => {
  const ranked = rankRunnableTasks(
    [
      task({ id: 1, priority: 5, createdAt: "2026-09-16T02:00:00.000Z" }),
      task({ id: 2, priority: 9, createdAt: "2026-09-16T03:00:00.000Z" }),
      task({ id: 3, priority: 5, createdAt: "2026-09-16T01:00:00.000Z" }),
    ],
    new Set(),
  );
  assert.deepEqual(ranked.map((t) => t.id), [2, 3, 1]);
});

test("ranking drops human-only tasks, missing autonomy, and autonomy above the ceiling", () => {
  const ranked = rankRunnableTasks(
    [
      task({ id: 1, executorMode: "human" }),
      task({ id: 2, autonomyLevel: null }),
      task({ id: 3, autonomyLevel: 5 }),
      task({ id: 4, executorMode: "human+agent" }),
      task({ id: 5 }),
    ],
    new Set(),
  );
  assert.deepEqual(ranked.map((t) => t.id).sort(), [4, 5]);
});

test("ranking drops tasks with an unfinished dependency", () => {
  const ranked = rankRunnableTasks([task({ id: 1 }), task({ id: 2 })], new Set([1]));
  assert.deepEqual(ranked.map((t) => t.id), [2]);
});

// --- pacing ----------------------------------------------------------------

test("pace does not throttle while the queue fits inside the remaining budget", () => {
  const pace = computePace(50, 10, 8, 15);
  assert.equal(pace.mode, "unthrottled");
  assert.equal(pace.perSlotUsd, 15);
});

test("pace spreads the budget across remaining slots once the queue could burn it early", () => {
  const pace = computePace(50, 200, 8, 15);
  assert.equal(pace.mode, "throttled");
  assert.equal(pace.perSlotUsd, 50 / 8);
});

test("the session cap is an absolute ceiling even when spreading would allow more", () => {
  const pace = computePace(500, 5000, 2, 15);
  assert.equal(pace.perSlotUsd, 15);
});

test("no slots left means nothing can be paced", () => {
  assert.deepEqual(computePace(50, 10, 0, 15), { mode: "unthrottled", perSlotUsd: 0, slotCount: 0 });
});

// --- time capacity ---------------------------------------------------------

test("time capacity scales with concurrency and is unbounded without duration history", () => {
  assert.equal(slotTimeCapacity(5 * HOUR, 1, 30 * 60_000), 10);
  assert.equal(slotTimeCapacity(5 * HOUR, 2, 30 * 60_000), 20);
  assert.equal(slotTimeCapacity(5 * HOUR, 2, null), Number.POSITIVE_INFINITY);
});

// --- packing ---------------------------------------------------------------

const packDefaults = {
  running: [],
  estimate: flat(2),
  sessionCapUsd: 15,
  concurrency: 2,
  meanDurationMs: null,
};

test("packing fills slots in rank order and stops each one at its cap", () => {
  const result = packPlan({
    ...packDefaults,
    slots: [slot(0), slot(5)],
    ranked: [task({ id: 1 }), task({ id: 2 }), task({ id: 3 }), task({ id: 4 })],
    pace: { mode: "throttled", perSlotUsd: 5, slotCount: 2 },
    remainingBudgetUsd: 50,
  });
  // $5 per slot at $2 a task: two tasks per slot, the fifth dollar unused.
  assert.deepEqual(result.slots[0].tasks.map((t) => t.taskId), [1, 2]);
  assert.deepEqual(result.slots[1].tasks.map((t) => t.taskId), [3, 4]);
  assert.equal(result.slots[0].plannedUsd, 4);
  assert.equal(result.slots[0].availableUsd, 1);
  assert.equal(result.deferred.length, 0);
});

test("the open slot's cap is reduced by what it has already spent", () => {
  const result = packPlan({
    ...packDefaults,
    slots: [slot(-1, 5, false, 13)],
    ranked: [task({ id: 1 }), task({ id: 2 })],
    pace: { mode: "unthrottled", perSlotUsd: 15, slotCount: 1 },
    remainingBudgetUsd: 50,
  });
  // $15 cap less $13 already spent leaves room for exactly one $2 task.
  assert.equal(result.slots[0].capUsd, 2);
  assert.equal(result.slots[0].tasks.length, 1);
});

test("packing never exceeds the remaining period budget across all slots", () => {
  const result = packPlan({
    ...packDefaults,
    slots: [slot(0), slot(5), slot(10)],
    ranked: [task({ id: 1 }), task({ id: 2 }), task({ id: 3 }), task({ id: 4 })],
    pace: { mode: "unthrottled", perSlotUsd: 15, slotCount: 3 },
    remainingBudgetUsd: 5,
  });
  const total = result.slots.reduce((sum, s) => sum + s.plannedUsd, 0);
  assert.equal(total, 4); // two $2 tasks; a third would exceed $5
  assert.equal(result.deferred.length, 2);
  assert.equal(result.binding, "budget");
});

test("time capacity can bind before budget does", () => {
  const result = packPlan({
    ...packDefaults,
    slots: [slot(0)],
    ranked: [task({ id: 1 }), task({ id: 2 }), task({ id: 3 })],
    pace: { mode: "unthrottled", perSlotUsd: 15, slotCount: 1 },
    remainingBudgetUsd: 50,
    concurrency: 1,
    meanDurationMs: 2.5 * HOUR, // only two runs fit in a 5h slot at concurrency 1
  });
  assert.equal(result.slots[0].timeCapacity, 2);
  assert.equal(result.slots[0].tasks.length, 2);
  assert.equal(result.binding, "time");
});

test("a task that does not fit does not let a cheaper lower-priority one jump it", () => {
  const estimates = new Map([
    [1, 10],
    [2, 1],
  ]);
  const result = packPlan({
    ...packDefaults,
    slots: [slot(0)],
    ranked: [task({ id: 1, priority: 9 }), task({ id: 2, priority: 1 })],
    estimate: (t) => ({ costUsd: estimates.get(t.id) ?? 1, basis: "global-mean" }),
    pace: { mode: "throttled", perSlotUsd: 5, slotCount: 1 },
    remainingBudgetUsd: 50,
  });
  // Priority is the operator's override lever - a cheap task must not
  // overtake an expensive higher-priority one just because it fits.
  assert.equal(result.slots[0].tasks.length, 0);
  assert.deepEqual(result.deferred.map((t) => t.id), [1, 2]);
});

test("a refusal blames the budget only when the budget is actually the obstacle", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    estimate: () => ({ costUsd: 99, basis: "global-mean" as const }),
  });
  assert.deepEqual(result.tasks, []);
  assert.match(result.reason ?? "", /fits the remaining budget/);
});

test("an empty runnable queue is reported as such, not as a poor budget fit", () => {
  const result = startableNow({ ...startDefaults, ranked: [] });
  assert.match(result.reason ?? "", /nothing runnable/);
});

test("running tasks appear in the open slot but are not re-planned", () => {
  const result = packPlan({
    ...packDefaults,
    slots: [slot(0, 5, false), slot(5)],
    ranked: [task({ id: 2 })],
    running: [
      { taskId: 99, title: "running", projectId: 9, priority: 0, estimatedCostUsd: 2, estimateBasis: "global-mean", running: true },
    ],
    pace: { mode: "unthrottled", perSlotUsd: 15, slotCount: 2 },
    remainingBudgetUsd: 50,
  });
  assert.equal(result.slots[0].tasks[0].taskId, 99);
  assert.equal(result.slots[0].tasks[0].running, true);
  assert.equal(result.slots[1].tasks.some((t) => t.running), false);
});

test("running tasks still show in the first slot when no session window is open", () => {
  const result = packPlan({
    ...packDefaults,
    slots: [slot(0), slot(5)], // both hypothetical - nothing has spent yet
    ranked: [],
    running: [
      { taskId: 99, title: "running", projectId: 9, priority: 0, estimatedCostUsd: 2, estimateBasis: "global-mean", running: true },
    ],
    pace: { mode: "unthrottled", perSlotUsd: 15, slotCount: 2 },
    remainingBudgetUsd: 50,
  });
  assert.deepEqual(result.slots[0].tasks.map((t) => t.taskId), [99]);
  assert.equal(result.slots[1].tasks.length, 0);
});

test("binding is 'queue' when every runnable task was placed with room to spare", () => {
  const result = packPlan({
    ...packDefaults,
    slots: [slot(0), slot(5)],
    ranked: [task({ id: 1 })],
    pace: { mode: "unthrottled", perSlotUsd: 15, slotCount: 2 },
    remainingBudgetUsd: 50,
  });
  assert.equal(result.binding, "queue");
  assert.equal(result.deferred.length, 0);
});

// --- load verdict ----------------------------------------------------------

test("load verdict distinguishes too little work from too much", () => {
  assert.equal(loadVerdict(10, 50), "underloaded");
  assert.equal(loadVerdict(50, 50), "balanced");
  assert.equal(loadVerdict(100, 50), "overloaded");
});

test("load verdict boundaries follow the declared coverage thresholds", () => {
  assert.equal(loadVerdict(UNDERLOAD_COVERAGE * 50, 50), "balanced");
  assert.equal(loadVerdict(UNDERLOAD_COVERAGE * 50 - 0.01, 50), "underloaded");
  assert.equal(loadVerdict(OVERLOAD_COVERAGE * 50, 50), "balanced");
  assert.equal(loadVerdict(OVERLOAD_COVERAGE * 50 + 0.01, 50), "overloaded");
});

test("load verdict is unknown with no budget to compare against", () => {
  assert.equal(loadVerdict(10, 0), "unknown");
});

// --- startable now ---------------------------------------------------------

const startDefaults = {
  running: [],
  estimate: flat(2),
  sessionRemainingUsd: 15,
  sessionResetsAt: null,
  periodRemainingUsd: 50,
  periodConfigured: true,
  concurrency: 2,
};

test("startableNow returns up to the concurrency limit, in rank order", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 }), task({ id: 2 }), task({ id: 3 })],
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1, 2]);
  assert.equal(result.waitUntil, null);
});

// two tasks on one repo used to be refused here - each run now
// gets its own clone of every repo it may write to, so the only thing left
// deciding how many start at once is the concurrency limit.
test("startableNow starts two tasks on the same repo now that each run has its own clone", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1, projectId: 10 }), task({ id: 2, projectId: 10 })],
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1, 2]);
});

test("startableNow starts a task whose repo a running task already holds", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1, projectId: 1 })],
    running: [{ taskId: 99 }],
    concurrency: 3,
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1]);
});

test("an exhausted session window asks the caller to wait rather than refusing outright", () => {
  const resetsAt = new Date(T0.getTime() + 2 * HOUR);
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    sessionRemainingUsd: 0,
    sessionResetsAt: resetsAt,
  });
  assert.deepEqual(result.tasks, []);
  assert.equal(result.waitUntil, resetsAt.toISOString());
});

test("override skips the budget gates but never the concurrency limit", () => {
  // Budget exhausted on both scopes, and the task costs more than either.
  const allowed = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    sessionRemainingUsd: 0,
    periodRemainingUsd: 0,
    sessionResetsAt: new Date(),
    override: true,
  });
  assert.deepEqual(allowed.tasks.map((t) => t.taskId), [1]);

  // Same override, but every agent slot is taken - still refused.
  const refused = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    running: [{ taskId: 98 }, { taskId: 99 }],
    sessionRemainingUsd: 0,
    periodRemainingUsd: 0,
    override: true,
  });
  assert.deepEqual(refused.tasks, []);
});

test("override does not bypass the concurrency limit either", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    running: [{ taskId: 98 }, { taskId: 99 }],
    override: true,
  });
  assert.deepEqual(result.tasks, []);
  assert.match(result.reason ?? "", /concurrency limit/);
});

test("override lets work proceed with no budget period configured at all", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    periodConfigured: false,
    periodRemainingUsd: 0,
    override: true,
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1]);
});

test("no configured period is reported as such, not as an exhausted budget", () => {
  const result = startableNow({ ...startDefaults, ranked: [task({ id: 1 })], periodConfigured: false, periodRemainingUsd: 0 });
  assert.deepEqual(result.tasks, []);
  assert.match(result.reason ?? "", /no budget period/);
});

test("an exhausted period budget is refused with no wait - waiting will not help", () => {
  const result = startableNow({ ...startDefaults, ranked: [task({ id: 1 })], periodRemainingUsd: 0 });
  assert.deepEqual(result.tasks, []);
  assert.equal(result.waitUntil, null);
  assert.match(result.reason ?? "", /period budget/);
});

test("a full concurrency limit is refused with no wait", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    running: [{ taskId: 98 }, { taskId: 99 }],
  });
  assert.deepEqual(result.tasks, []);
  assert.match(result.reason ?? "", /concurrency limit/);
});

test("the remaining session budget caps a batch even below the concurrency limit", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 }), task({ id: 2 })],
    sessionRemainingUsd: 3, // room for one $2 task, not two
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1]);
});

test("the period budget caps a batch the same way the session budget does", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 }), task({ id: 2 })],
    periodRemainingUsd: 3,
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1]);
});

// a seat's own concurrency limit, on top of the global one.
test("startableNow stops at this seat's own limit while the global cap still has room", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 }), task({ id: 2 })],
    concurrency: 4,
    seatConcurrency: 1,
    seatRunning: 0,
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1]);
});

test("a seat already at its limit is refused by name, not by the global limit", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    concurrency: 4,
    seatConcurrency: 2,
    seatRunning: 2,
  });
  assert.deepEqual(result.tasks, []);
  assert.match(result.reason ?? "", /this license's concurrency limit \(2\)/);
});

test("the global limit is still named when it is the one that bit", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    running: [{ taskId: 98 }, { taskId: 99 }],
    concurrency: 2,
    seatConcurrency: 5,
    seatRunning: 0,
  });
  assert.deepEqual(result.tasks, []);
  assert.match(result.reason ?? "", /concurrency limit \(2\)/);
  assert.doesNotMatch(result.reason ?? "", /license/);
});

test("a caller that knows nothing about seats behaves exactly as before", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 }), task({ id: 2 }), task({ id: 3 })],
    concurrency: 2,
  });
  assert.deepEqual(result.tasks.map((t) => t.taskId), [1, 2]);
});

test("both caps full is reported as both, not just the global one", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    running: [{ taskId: 98 }, { taskId: 99 }],
    concurrency: 2,
    seatConcurrency: 1,
    seatRunning: 1,
  });
  assert.deepEqual(result.tasks, []);
  assert.match(result.reason ?? "", /concurrency limit \(2\) reached, and this license's own limit \(1\) too/);
});

// a reported session limit must reach the dispatcher as a real
// waitUntil, and must say why - "budget is spent" is a lie when nothing was.

test("a reported session limit produces a waitUntil and names itself as the cause", () => {
  const resetsAt = new Date("2026-09-17T01:40:00.000Z");
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    sessionRemainingUsd: 0,
    sessionResetsAt: resetsAt,
    sessionLimitReported: true,
  });

  assert.deepEqual(result.tasks, []);
  assert.equal(result.waitUntil, resetsAt.toISOString());
  assert.match(result.reason ?? "", /session limit/i);
  assert.doesNotMatch(result.reason ?? "", /budget is spent/i);
});

test("an ordinary spent window still reports it as a spent budget", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    sessionRemainingUsd: 0,
    sessionResetsAt: new Date("2026-09-17T01:40:00.000Z"),
  });

  assert.match(result.reason ?? "", /budget is spent/i);
});

test("a spent session window is reported even when the seat is also full", () => {
  const result = startableNow({
    ...startDefaults,
    ranked: [task({ id: 1 })],
    running: [{ taskId: 9 }],
    sessionRemainingUsd: 0,
    sessionResetsAt: new Date("2026-09-29T03:20:00Z"),
    sessionLimitReported: true,
    seatConcurrency: 1,
    seatRunning: 1,
  });
  assert.deepEqual(result.tasks, []);
  assert.equal(result.waitUntil, "2026-09-29T03:20:00.000Z");
  assert.match(result.reason ?? "", /Claude reported/);
});

// ---------------------------------------------------------------------------
// weekly recurring budget periods
// ---------------------------------------------------------------------------

const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// In-memory RecurrenceStore. lockLicense takes a per-license mutex held until
// the transaction ends, which is what the license row lock does in Postgres.
function memoryRecurrence(settings: Record<number, RecurrenceSettings>, periods: StoredPeriod[] = []) {
  const locks = new Map<number, Promise<void>>();
  let nextId = periods.length + 1;
  const store: RecurrenceStore = {
    async transaction(fn) {
      const releases: (() => void)[] = [];
      const tx: RecurrenceTx = {
        async lockLicense(licenseId) {
          while (locks.has(licenseId)) await locks.get(licenseId);
          let release!: () => void;
          locks.set(licenseId, new Promise<void>((r) => (release = r)));
          releases.push(() => {
            locks.delete(licenseId);
            release();
          });
          return settings[licenseId] ?? null;
        },
        async coveringPeriod(licenseId, now) {
          return periods.find((p) => p.licenseId === licenseId && p.startsAt < now && p.endsAt >= now) ?? null;
        },
        async latestPeriod(licenseId) {
          const mine = periods.filter((p) => p.licenseId === licenseId).sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime());
          // Yield so concurrent transactions actually interleave.
          await new Promise((r) => setImmediate(r));
          return mine[0] ?? null;
        },
        async insertPeriod(row) {
          const p = { id: nextId++, licenseId: row.licenseId, startsAt: row.startsAt, endsAt: row.endsAt, budgetUsd: row.budgetUsd, note: row.note };
          periods.push(p);
          return p;
        },
      };
      try {
        return await fn(tx);
      } finally {
        releases.forEach((r) => r());
      }
    },
  };
  return { store, periods: periods as (StoredPeriod & { budgetUsd?: number; note?: string })[] };
}

const ANCHOR = new Date("2026-10-06T08:00:00.000Z");
const on = (budgetUsd = 50): RecurrenceSettings => ({ enabled: true, budgetUsd });
const period = (id: number, licenseId: number, endsAt: Date, weeks = 1): StoredPeriod => ({
  id,
  licenseId,
  startsAt: new Date(endsAt.getTime() - weeks * WEEK),
  endsAt,
});

test("nextRecurringPeriod is the week right after the anchor, and nothing while the anchor is in the future", () => {
  const next = nextRecurringPeriod(ANCHOR, new Date(ANCHOR.getTime() + HOUR));
  assert.deepEqual(next, { startsAt: ANCHOR, endsAt: new Date(ANCHOR.getTime() + WEEK) });
  assert.equal(nextRecurringPeriod(ANCHOR, ANCHOR), null);
  assert.equal(nextRecurringPeriod(ANCHOR, new Date(ANCHOR.getTime() - HOUR)), null);
  // Exactly on a week boundary, the week ending at now covers it (endsAt >= now).
  assert.deepEqual(nextRecurringPeriod(ANCHOR, new Date(ANCHOR.getTime() + WEEK)), {
    startsAt: ANCHOR,
    endsAt: new Date(ANCHOR.getTime() + WEEK),
  });
});

test("nextRecurringPeriod fast-forwards over missed weeks to the one covering now", () => {
  const now = new Date(ANCHOR.getTime() + 3 * WEEK + 2 * DAY);
  assert.deepEqual(nextRecurringPeriod(ANCHOR, now), {
    startsAt: new Date(ANCHOR.getTime() + 3 * WEEK),
    endsAt: new Date(ANCHOR.getTime() + 4 * WEEK),
  });
});

test("rollover creates exactly one period covering now, with the pattern's amount and note", async () => {
  const { store, periods } = memoryRecurrence({ 1: on(40) }, [period(1, 1, ANCHOR)]);
  const now = new Date(ANCHOR.getTime() + DAY);
  const created = await ensureRecurringPeriod(store, 1, now);
  assert.ok(created);
  assert.equal(periods.length, 2);
  assert.deepEqual([periods[1].startsAt, periods[1].endsAt], [ANCHOR, new Date(ANCHOR.getTime() + WEEK)]);
  assert.equal(periods[1].budgetUsd, 40);
  assert.equal(periods[1].note, RECURRENCE_NOTE);
  // Called again: something covers now, nothing more is created.
  assert.equal(await ensureRecurringPeriod(store, 1, now), null);
  assert.equal(periods.length, 2);
});

test("rollover after several missed weeks inserts only the week covering now", async () => {
  const { store, periods } = memoryRecurrence({ 1: on() }, [period(1, 1, ANCHOR)]);
  const now = new Date(ANCHOR.getTime() + 4 * WEEK + HOUR);
  await ensureRecurringPeriod(store, 1, now);
  assert.equal(periods.length, 2);
  assert.deepEqual(periods[1].startsAt, new Date(ANCHOR.getTime() + 4 * WEEK));
  assert.deepEqual(periods[1].endsAt, new Date(ANCHOR.getTime() + 5 * WEEK));
});

test("disabled recurrence, no amount, or no anchor creates nothing", async () => {
  const now = new Date(ANCHOR.getTime() + DAY);
  const off = memoryRecurrence({ 1: { enabled: false, budgetUsd: 50 } }, [period(1, 1, ANCHOR)]);
  assert.equal(await ensureRecurringPeriod(off.store, 1, now), null);
  assert.equal(off.periods.length, 1);
  const noAmount = memoryRecurrence({ 1: { enabled: true, budgetUsd: null } }, [period(1, 1, ANCHOR)]);
  assert.equal(await ensureRecurringPeriod(noAmount.store, 1, now), null);
  const noAnchor = memoryRecurrence({ 1: on() });
  assert.equal(await ensureRecurringPeriod(noAnchor.store, 1, now), null);
  assert.equal(noAnchor.periods.length, 0);
  const unknown = memoryRecurrence({}, [period(1, 1, ANCHOR)]);
  assert.equal(await ensureRecurringPeriod(unknown.store, 1, now), null);
});

test("a one-off end date re-anchors the weeks after it", async () => {
  // The operator stretched the current period to end on a Thursday afternoon.
  const oneOff = new Date("2026-10-15T15:30:00.000Z");
  const { store, periods } = memoryRecurrence({ 1: on() }, [{ id: 1, licenseId: 1, startsAt: new Date(ANCHOR.getTime() - WEEK), endsAt: oneOff }]);
  await ensureRecurringPeriod(store, 1, new Date(oneOff.getTime() + HOUR));
  assert.deepEqual([periods[1].startsAt, periods[1].endsAt], [oneOff, new Date(oneOff.getTime() + WEEK)]);
  await ensureRecurringPeriod(store, 1, new Date(oneOff.getTime() + WEEK + HOUR));
  assert.deepEqual(periods[2].endsAt, new Date(oneOff.getTime() + 2 * WEEK));
});

test("one seat's recurrence never creates a period for another seat", async () => {
  const { store, periods } = memoryRecurrence({ 1: { enabled: false, budgetUsd: null }, 2: on() }, [period(1, 1, ANCHOR), period(2, 2, ANCHOR)]);
  const now = new Date(ANCHOR.getTime() + DAY);
  assert.equal(await ensureRecurringPeriod(store, 1, now), null);
  await ensureRecurringPeriod(store, 2, now);
  assert.equal(periods.length, 3);
  assert.equal(periods.filter((p) => p.licenseId === 1).length, 1);
  assert.equal(periods[2].licenseId, 2);
});

test("concurrent plan reads create one period", async () => {
  const { store, periods } = memoryRecurrence({ 1: on() }, [period(1, 1, ANCHOR)]);
  const now = new Date(ANCHOR.getTime() + DAY);
  const results = await Promise.all([1, 2, 3, 4].map(() => ensureRecurringPeriod(store, 1, now)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(periods.length, 2);
});

test("describeRecurrence's nextEndsAt is a week past the latest period, only when enabled", () => {
  assert.deepEqual(describeRecurrence(on(30), ANCHOR), {
    enabled: true,
    budgetUsd: 30,
    nextEndsAt: new Date(ANCHOR.getTime() + WEEK).toISOString(),
  });
  assert.equal(describeRecurrence({ enabled: false, budgetUsd: 30 }, ANCHOR).nextEndsAt, null);
  assert.equal(describeRecurrence(on(), null).nextEndsAt, null);
});

test("validateRecurrencePatch: blank is null, enabling needs an amount, clearing while on is refused", () => {
  const off = { recurrenceEnabled: false, recurrenceBudgetUsd: null };
  assert.deepEqual(validateRecurrencePatch({ recurrenceEnabled: true, recurrenceBudgetUsd: 50 }, off), { recurrenceEnabled: true, recurrenceBudgetUsd: 50 });
  assert.deepEqual(validateRecurrencePatch({ recurrenceBudgetUsd: "" }, off), { recurrenceBudgetUsd: null });
  assert.throws(() => validateRecurrencePatch({ recurrenceEnabled: true }, off), /positive number/);
  assert.throws(() => validateRecurrencePatch({ recurrenceEnabled: true, recurrenceBudgetUsd: 0 }, off), /positive number/);
  assert.throws(() => validateRecurrencePatch({ recurrenceEnabled: "yes" }, off), /boolean/);
  const enabled = { recurrenceEnabled: true, recurrenceBudgetUsd: 50 };
  assert.deepEqual(validateRecurrencePatch({ recurrenceEnabled: true }, enabled), { recurrenceEnabled: true });
  assert.throws(() => validateRecurrencePatch({ recurrenceBudgetUsd: null }, enabled), /while weekly recurrence is on/);
  assert.deepEqual(validateRecurrencePatch({ recurrenceEnabled: false, recurrenceBudgetUsd: null }, enabled), {
    recurrenceEnabled: false,
    recurrenceBudgetUsd: null,
  });
});
