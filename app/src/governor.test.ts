import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "./config.js";
import { cycleStartFor, deriveState, estimatePercent, nextWeeklyReset, worstState } from "./governor.js";

test("deriveState is unconfigured with no observation", () => {
  assert.equal(deriveState(null), "unconfigured");
});

test("deriveState ranks available percent against configured thresholds", () => {
  const t = config.governor;
  assert.equal(deriveState(t.overRateThresholdPercent + 1), "healthy");
  assert.equal(deriveState(t.overRateThresholdPercent), "over_rate");
  assert.equal(deriveState(t.dangerThresholdPercent), "danger");
  assert.equal(deriveState(t.criticalThresholdPercent), "critical");
});

test("worstState only reports unconfigured when both sides lack data", () => {
  assert.equal(worstState("unconfigured", "healthy"), "healthy");
  assert.equal(worstState("healthy", "unconfigured"), "healthy");
  assert.equal(worstState("unconfigured", "danger"), "danger");
  assert.equal(worstState("unconfigured", "unconfigured"), "unconfigured");
});

test("worstState ranks danger above over_rate above healthy", () => {
  assert.equal(worstState("healthy", "danger"), "danger");
  assert.equal(worstState("over_rate", "danger"), "danger");
  assert.equal(worstState("critical", "healthy"), "critical");
});

test("nextWeeklyReset rolls forward to the configured day/hour", () => {
  // 2026-09-08 is a Tuesday; default reset is Friday (5) 16:00.
  const now = new Date("2026-09-08T10:00:00");
  const next = nextWeeklyReset(now);
  assert.equal(next.getDay(), config.governor.resetDayOfWeek);
  assert.equal(next.getHours(), config.governor.resetHour);
  assert.ok(next.getTime() > now.getTime());
  assert.ok(next.getTime() - now.getTime() <= 7 * 24 * 3_600_000);
});

test("nextWeeklyReset skips to next week once today's reset has passed", () => {
  const now = new Date("2026-09-11T17:00:00"); // Friday, after 16:00
  if (now.getDay() === config.governor.resetDayOfWeek && now.getHours() >= config.governor.resetHour) {
    const next = nextWeeklyReset(now);
    assert.ok(next.getTime() - now.getTime() > 6 * 24 * 3_600_000);
  }
});

test("cycleStartFor has no tracked cycle boundary for the rolling session window", () => {
  assert.equal(cycleStartFor("session"), null);
});

test("cycleStartFor returns the most recent weekly reset for the week scope", () => {
  // 2026-09-08 is a Tuesday; default reset is Friday (5) 16:00, so the most
  // recent one is the prior Friday.
  const now = new Date("2026-09-08T10:00:00");
  const start = cycleStartFor("week", now);
  assert.ok(start);
  assert.equal(start!.getDay(), config.governor.resetDayOfWeek);
  assert.equal(start!.getHours(), config.governor.resetHour);
  assert.ok(start!.getTime() <= now.getTime());
});

test("estimatePercent converts cost to a %-of-window using a $-per-% rate", () => {
  assert.equal(estimatePercent(10, 2), 5);
  assert.equal(estimatePercent(10, null), null);
  assert.equal(estimatePercent(10, 0), null);
});
