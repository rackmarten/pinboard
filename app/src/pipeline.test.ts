import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTransition, openPrBlocksDone, isPipelineStatus, isRepairReason, keepRepairOnPatch, PIPELINE_STATUSES } from "./pipeline.js";

test("a finished session enters the pipeline from executing or handoff", () => {
  assert.equal(checkTransition("executing", "awaiting_ci").ok, true);
  assert.equal(checkTransition("handoff", "awaiting_ci").ok, true);
});

test("a no-commit session ending on a question parks from handoff", () => {
  assert.equal(checkTransition("handoff", "needs_input").ok, true);
});

test("the happy path runs CI -> merge -> deploy -> verify -> review", () => {
  assert.equal(checkTransition("awaiting_ci", "awaiting_merge").ok, true);
  assert.equal(checkTransition("awaiting_merge", "deploying").ok, true);
  assert.equal(checkTransition("deploying", "verifying").ok, true);
  assert.equal(checkTransition("verifying", "review").ok, true);
  // foreman auto-closes a verified executorMode=agent task.
  assert.equal(checkTransition("verifying", "done", undefined, "agent").ok, true);
  assert.equal(checkTransition("deploying", "done").ok, false);
});

test("a green PR can park at review when nothing will merge it automatically", () => {
  // No auto-deploy opt-in on the project, or a merged PR whose repo has no
  // LXC to deploy to - both end at a human, not at a failure.
  assert.equal(checkTransition("awaiting_ci", "review").ok, true);
  assert.equal(checkTransition("awaiting_merge", "review").ok, true);
});

test("a migration hold is released into merge, not straight into deploy", () => {
  assert.equal(checkTransition("awaiting_review", "awaiting_merge").ok, true);
  assert.equal(checkTransition("awaiting_review", "deploying").ok, false);
});

test("skipping a stage is refused, and the refusal names what is allowed", () => {
  const result = checkTransition("awaiting_ci", "deploying");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /cannot move a task from 'awaiting_ci' to 'deploying'/);
  assert.match(result.ok ? "" : result.reason, /awaiting_merge/);
});

test("going backwards through the pipeline is refused", () => {
  assert.equal(checkTransition("deploying", "awaiting_ci").ok, false);
  assert.equal(checkTransition("verifying", "deploying").ok, false);
});

test("a task outside the pipeline has nothing to advance", () => {
  const result = checkTransition("idea", "awaiting_ci");
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /not a pipeline status/);
  assert.equal(checkTransition("done", "awaiting_ci").ok, false);
  assert.equal(checkTransition("queued", "awaiting_ci").ok, false);
  assert.equal(checkTransition("nonsense", "awaiting_ci").ok, false);
});

test("an unknown target status is refused from a valid stage", () => {
  assert.equal(checkTransition("awaiting_ci", "shipped").ok, false);
});

test("every pipeline stage can hand back to an agent, or out to a human", () => {
  for (const stage of PIPELINE_STATUSES) {
    assert.equal(checkTransition(stage, "queued", "ci_failed").ok, true, `${stage} -> queued`);
    assert.equal(checkTransition(stage, "rework").ok, true, `${stage} -> rework`);
    assert.equal(checkTransition(stage, "rejected").ok, true, `${stage} -> rejected`);
  }
});

test("a handback to queued must say what the agent is being asked to fix", () => {
  const missing = checkTransition("awaiting_ci", "queued");
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /repairReason/);
  assert.equal(checkTransition("awaiting_ci", "queued", "went_wrong").ok, false);
  assert.equal(checkTransition("deploying", "queued", "deploy_failed").ok, true);
  assert.equal(checkTransition("awaiting_merge", "queued", "merge_conflict").ok, true);
});

test("a repairReason on anything but a handback is refused rather than ignored", () => {
  // Silently dropping it would leave the caller believing it recorded a
  // reason that was never stored.
  assert.equal(checkTransition("awaiting_ci", "awaiting_merge", "ci_failed").ok, false);
  assert.equal(checkTransition("awaiting_ci", "awaiting_merge", null).ok, true);
  assert.equal(checkTransition("awaiting_ci", "awaiting_merge", undefined).ok, true);
});

test("only an autonomous task is handed back to an agent", () => {
  assert.equal(checkTransition("deploying", "queued", "deploy_failed", "agent").ok, true);
  const refused = checkTransition("deploying", "queued", "deploy_failed", "human+agent");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /rework/);
});

test("a park in rework may carry the failure's reason", () => {
  assert.equal(checkTransition("deploying", "rework", "deploy_failed", "human+agent").ok, true);
  assert.equal(checkTransition("awaiting_ci", "rework", "went_wrong").ok, false);
  assert.equal(checkTransition("awaiting_ci", "rejected", "ci_failed").ok, false);
});

test("a PATCH keeps repair evidence only on a requeue out of rework", () => {
  assert.equal(keepRepairOnPatch("rework", "queued"), true);
  // #157: a human requeue from anywhere else is not a repair.
  assert.equal(keepRepairOnPatch("review", "queued"), false);
  // The runner parking a task after its attempts ran out must not leave a
  // stale reason behind.
  assert.equal(keepRepairOnPatch("executing", "rework"), false);
  // The runner's claim reads the fields after moving to executing.
  assert.equal(keepRepairOnPatch("queued", "executing"), true);
});

test("status and reason guards agree with the exported lists", () => {
  assert.equal(isPipelineStatus("awaiting_ci"), true);
  assert.equal(isPipelineStatus("review"), false);
  assert.equal(isRepairReason("ci_failed"), true);
  assert.equal(isRepairReason("ci-failed"), false);
  assert.equal(isRepairReason(undefined), false);
});

test("review -> awaiting_merge (approve merges an open PR)", () => {
  assert.deepEqual(checkTransition("review", "awaiting_merge"), { ok: true });
  assert.equal(checkTransition("review", "deploying").ok, false);
});

test("needs_input parks and resumes without a repairReason", () => {
  assert.deepEqual(checkTransition("queued", "needs_input"), { ok: true });
  assert.deepEqual(checkTransition("executing", "needs_input"), { ok: true });
  assert.deepEqual(checkTransition("needs_input", "queued"), { ok: true });
  assert.deepEqual(checkTransition("needs_input", "rework"), { ok: true });
  assert.deepEqual(checkTransition("needs_input", "rejected"), { ok: true });
  assert.equal(checkTransition("needs_input", "queued", "ci_failed").ok, false);
  assert.equal(checkTransition("needs_input", "done").ok, false);
  assert.equal(checkTransition("review", "needs_input").ok, false);
});

test("an open PR row blocks done unless forced", () => {
  assert.equal(openPrBlocksDone([], false), false);
  assert.equal(openPrBlocksDone(["merged", "closed"], false), false);
  assert.equal(openPrBlocksDone(["merged", "open"], false), true);
  assert.equal(openPrBlocksDone(["open"], true), false);
});
