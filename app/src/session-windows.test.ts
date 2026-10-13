import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SESSION_WINDOW_MS,
  deriveSessionWindows,
  openWindowAt,
  planSlots,
  sessionWindowState,
  type CostEvent,
} from "./session-windows.js";

const T0 = new Date("2026-09-16T10:00:00.000Z");
const at = (minutes: number, costUsd = 1): CostEvent => ({
  occurredAt: new Date(T0.getTime() + minutes * 60_000),
  costUsd,
});

test("no events means no windows", () => {
  assert.deepEqual(deriveSessionWindows([]), []);
});

test("one event opens one window running five hours from it", () => {
  const [w, ...rest] = deriveSessionWindows([at(0, 2.5)]);
  assert.equal(rest.length, 0);
  assert.equal(w.startsAt.getTime(), T0.getTime());
  assert.equal(w.endsAt.getTime(), T0.getTime() + SESSION_WINDOW_MS);
  assert.equal(w.spentUsd, 2.5);
  assert.equal(w.eventCount, 1);
});

test("events inside the window accumulate into it rather than opening new ones", () => {
  const windows = deriveSessionWindows([at(0, 1), at(60, 2), at(299, 3)]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].spentUsd, 6);
  assert.equal(windows[0].eventCount, 3);
});

test("an event exactly at the boundary opens the next window", () => {
  const windows = deriveSessionWindows([at(0, 1), at(300, 2)]);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].startsAt.getTime(), T0.getTime() + SESSION_WINDOW_MS);
  assert.equal(windows[1].spentUsd, 2);
});

test("a long gap leaves no window in between - the next action opens a fresh one", () => {
  const windows = deriveSessionWindows([at(0, 1), at(60 * 24, 2)]);
  assert.equal(windows.length, 2);
  // Not contiguous: the second window starts at the event, not at the first
  // window's expiry. This is the whole point of the model.
  assert.equal(windows[1].startsAt.getTime(), T0.getTime() + 60 * 24 * 60_000);
});

test("input need not be sorted", () => {
  const windows = deriveSessionWindows([at(299, 3), at(0, 1), at(60, 2)]);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startsAt.getTime(), T0.getTime());
  assert.equal(windows[0].spentUsd, 6);
});

test("openWindowAt reports the window only while it is still running", () => {
  const windows = deriveSessionWindows([at(0, 1)]);
  assert.ok(openWindowAt(windows, new Date(T0.getTime() + 60_000)));
  assert.equal(openWindowAt(windows, new Date(T0.getTime() + SESSION_WINDOW_MS)), null);
  assert.equal(openWindowAt([], T0), null);
});

test("with no window open the full session cap is available and nothing is waited on", () => {
  const state = sessionWindowState([], 15, T0);
  assert.equal(state.open, null);
  assert.equal(state.remainingUsd, 15);
  assert.equal(state.resetsAt, null);
  assert.equal(state.exhausted, false);
});

test("an open window reduces the remaining cap by what it already spent", () => {
  const windows = deriveSessionWindows([at(0, 4)]);
  const state = sessionWindowState(windows, 15, new Date(T0.getTime() + 60_000));
  assert.equal(state.remainingUsd, 11);
  assert.equal(state.exhausted, false);
  assert.equal(state.resetsAt?.getTime(), T0.getTime() + SESSION_WINDOW_MS);
});

test("spending past the cap marks the window exhausted and gives a reset time to wait for", () => {
  const windows = deriveSessionWindows([at(0, 16)]);
  const state = sessionWindowState(windows, 15, new Date(T0.getTime() + 60_000));
  assert.equal(state.remainingUsd, 0);
  assert.equal(state.exhausted, true);
  assert.equal(state.resetsAt?.getTime(), T0.getTime() + SESSION_WINDOW_MS);
});

test("planSlots leads with the real open window, then lays hypothetical ones end to end", () => {
  const now = new Date(T0.getTime() + 60 * 60_000); // 1h into the window
  const state = sessionWindowState(deriveSessionWindows([at(0, 4)]), 15, now);
  const until = new Date(T0.getTime() + 15 * 60 * 60_000); // 15h after the window opened
  const slots = planSlots(state, now, until);

  assert.equal(slots[0].hypothetical, false);
  assert.equal(slots[0].spentUsd, 4);
  assert.equal(slots[0].startsAt.getTime(), T0.getTime());
  assert.ok(slots.length > 1);
  assert.equal(slots[1].hypothetical, true);
  assert.equal(slots[1].startsAt.getTime(), slots[0].endsAt.getTime());
  assert.equal(slots[1].spentUsd, 0);
});

test("planSlots truncates the final slot at the period end rather than dropping it", () => {
  const state = sessionWindowState([], 15, T0);
  const until = new Date(T0.getTime() + 6 * 60 * 60_000); // 6h: one full slot plus 1h
  const slots = planSlots(state, T0, until);
  assert.equal(slots.length, 2);
  assert.equal(slots[1].endsAt.getTime(), until.getTime());
  assert.equal(slots[1].endsAt.getTime() - slots[1].startsAt.getTime(), 60 * 60_000);
});

test("planSlots returns nothing when the period has already ended", () => {
  const state = sessionWindowState([], 15, T0);
  assert.deepEqual(planSlots(state, T0, new Date(T0.getTime() - 1)), []);
});

// a reported reset is ground truth and outranks the derivation.

test("a live reported reset marks the window exhausted even when spend is well under the cap", () => {
  const events: CostEvent[] = [{ occurredAt: T0, costUsd: 0.5 }];
  const now = new Date(T0.getTime() + 60 * 60_000);
  const resetsAt = new Date(T0.getTime() + 4 * 60 * 60_000);

  const state = sessionWindowState(deriveSessionWindows(events), 15, now, resetsAt);

  assert.equal(state.exhausted, true);
  assert.equal(state.remainingUsd, 0);
  assert.equal(state.resetsAt?.getTime(), resetsAt.getTime());
});

// The expensive case: the derivation sees no open window (last cost event is
// older than 5h) and would happily start work, while Claude's own limit is
// still in force. This is what burned tasks #117 and #115 on 2026-09-16.
test("a live reported reset blocks work even when the derived window has already expired", () => {
  const events: CostEvent[] = [{ occurredAt: T0, costUsd: 0.5 }];
  const now = new Date(T0.getTime() + 6 * 60 * 60_000);
  const resetsAt = new Date(now.getTime() + 30 * 60_000);

  const derivedOnly = sessionWindowState(deriveSessionWindows(events), 15, now);
  assert.equal(derivedOnly.exhausted, false);
  assert.equal(derivedOnly.remainingUsd, 15);

  const withReport = sessionWindowState(deriveSessionWindows(events), 15, now, resetsAt);
  assert.equal(withReport.exhausted, true);
  assert.equal(withReport.remainingUsd, 0);
  assert.equal(withReport.resetsAt?.getTime(), resetsAt.getTime());
});

test("a reported reset that has already passed is ignored and the derivation takes over", () => {
  const events: CostEvent[] = [{ occurredAt: T0, costUsd: 0.5 }];
  const now = new Date(T0.getTime() + 60 * 60_000);
  const stale = new Date(T0.getTime() - 60 * 60_000);

  const state = sessionWindowState(deriveSessionWindows(events), 15, now, stale);

  assert.equal(state.exhausted, false);
  assert.equal(state.remainingUsd, 14.5);
});

test("a reported reset replaces the derived window end but keeps its real start", () => {
  const events: CostEvent[] = [{ occurredAt: T0, costUsd: 0.5 }];
  const now = new Date(T0.getTime() + 60 * 60_000);
  const resetsAt = new Date(T0.getTime() + 4 * 60 * 60_000);

  const state = sessionWindowState(deriveSessionWindows(events), 15, now, resetsAt);

  assert.equal(state.open?.startsAt.getTime(), T0.getTime());
  assert.equal(state.open?.endsAt.getTime(), resetsAt.getTime());
  assert.notEqual(state.open?.endsAt.getTime(), T0.getTime() + SESSION_WINDOW_MS);
});
