import assert from "node:assert/strict";
import { test } from "node:test";
import { msUntilNextHour } from "./schedule.js";

test("msUntilNextHour targets later today when the hour hasn't passed yet", () => {
  const now = new Date("2026-09-08T06:00:00");
  const ms = msUntilNextHour(9, now);
  assert.equal(ms, 3 * 3_600_000);
});

test("msUntilNextHour rolls to tomorrow once the hour has passed", () => {
  const now = new Date("2026-09-08T10:00:00");
  const ms = msUntilNextHour(9, now);
  assert.equal(ms, 23 * 3_600_000);
});

test("msUntilNextHour rolls to tomorrow at the exact hour", () => {
  const now = new Date("2026-09-08T09:00:00");
  const ms = msUntilNextHour(9, now);
  assert.equal(ms, 24 * 3_600_000);
});
