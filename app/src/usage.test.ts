import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDigestText, currentWeeklyResetStart, type DigestData } from "./usage.js";

test("currentWeeklyResetStart finds the most recent occurrence before now", () => {
  // Wed 2026-09-16 10:00, reset is Friday 16:00 -> most recent is the
  // previous Friday (2026-09-11 16:00).
  const now = new Date(2026, 8, 16, 10, 0, 0);
  const start = currentWeeklyResetStart(now, 5, 16);
  assert.equal(start.toDateString(), new Date(2026, 8, 11).toDateString());
  assert.equal(start.getHours(), 16);
});

test("currentWeeklyResetStart uses today when the reset hour already passed", () => {
  // Fri 2026-09-11 18:00, reset is Friday 16:00 -> today's own reset.
  const now = new Date(2026, 8, 11, 18, 0, 0);
  const start = currentWeeklyResetStart(now, 5, 16);
  assert.equal(start.toDateString(), now.toDateString());
  assert.equal(start.getHours(), 16);
});

test("currentWeeklyResetStart rolls back a full week when today's reset hasn't happened yet", () => {
  // Fri 2026-09-11 10:00, reset is Friday 16:00 -> last week's Friday.
  const now = new Date(2026, 8, 11, 10, 0, 0);
  const start = currentWeeklyResetStart(now, 5, 16);
  assert.equal(start.toDateString(), new Date(2026, 8, 4).toDateString());
});

function digest(overrides: Partial<DigestData> = {}): DigestData {
  return {
    periodHours: 24,
    costUsd: 0,
    completed: [],
    waitingReview: [],
    failed: [],
    ...overrides,
  };
}

test("buildDigestText reports zero activity plainly", () => {
  const text = buildDigestText(digest());
  assert.match(text, /Cost: \$0\.00/);
  assert.match(text, /Completed \(0\):\n  none/);
  assert.match(text, /Waiting for review \(0\):\n  none/);
  assert.match(text, /Failed \/ rework \(0\):\n  none/);
});

test("buildDigestText lists each task with its id and title", () => {
  const text = buildDigestText(
    digest({
      costUsd: 1.2345,
      completed: [{ id: 6, title: "media: bulk queue-by-tag endpoint" }],
      waitingReview: [{ id: 9, title: "some review task" }],
      failed: [{ id: 7, title: "runaway attempt loop" }],
    }),
  );
  assert.match(text, /Cost: \$1\.23/);
  assert.match(text, /#6 media: bulk queue-by-tag endpoint/);
  assert.match(text, /#9 some review task/);
  assert.match(text, /#7 runaway attempt loop/);
});
