import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTransition,
  openPrBlocksDone,
  isPipelineStatus,
  isRepairReason,
  isReviewReason,
  keepRepairOnPatch,
  resolvePipelineTarget,
  PIPELINE_STATUSES,
} from "./pipeline.js";

test("a finished session enters the pipeline, waits for review, or parks on a question, from in_progress", () => {
  assert.equal(checkTransition("in_progress", "awaiting_ci").ok, true);
  // work with no PR: a human accepts the result
  assert.equal(checkTransition("in_progress", "review").ok, true);
  assert.equal(checkTransition("in_progress", "needs_input").ok, true);
  assert.equal(checkTransition("in_progress", "done").ok, false);
  assert.equal(checkTransition("in_progress", "awaiting_merge").ok, false);
});

test("the removed statuses are not pipeline states any more", () => {
  for (const gone of ["executing", "handoff", "awaiting_review", "planned"]) {
    assert.equal(checkTransition(gone, "awaiting_ci").ok, false, gone);
    assert.equal(checkTransition(gone, "awaiting_merge").ok, false, gone);
  }
  assert.equal(checkTransition("awaiting_ci", "awaiting_review").ok, false);
  assert.equal(isPipelineStatus("awaiting_review"), false);
});

test("the happy path runs CI -> merge -> deploy -> verify -> done, for every executor mode", () => {
  assert.equal(checkTransition("awaiting_ci", "awaiting_merge").ok, true);
  assert.equal(checkTransition("awaiting_merge", "deploying").ok, true);
  assert.equal(checkTransition("deploying", "verifying").ok, true);
  for (const mode of ["agent", "human+agent", "human", undefined]) {
    assert.equal(checkTransition("verifying", "done", undefined, mode).ok, true, String(mode));
  }
  // no post-deploy sign-off.
  assert.equal(checkTransition("verifying", "review").ok, false);
  assert.equal(checkTransition("deploying", "done").ok, false);
});

test("a merged PR with nothing to deploy is done, not review", () => {
  assert.equal(checkTransition("awaiting_merge", "done").ok, true);
  assert.equal(checkTransition("awaiting_merge", "review").ok, false);
});

test("a green PR held for a human goes to review, with a reason", () => {
  assert.equal(checkTransition("awaiting_ci", "review").ok, true);
  for (const reason of ["migration", "no_auto_deploy", "production"]) {
    assert.deepEqual(checkTransition("awaiting_ci", "review", undefined, undefined, reason), { ok: true });
  }
  assert.equal(checkTransition("awaiting_ci", "review", undefined, undefined, "because").ok, false);
  // a reason only belongs on a move into review.
  assert.equal(checkTransition("awaiting_ci", "awaiting_merge", undefined, undefined, "migration").ok, false);
  assert.equal(isReviewReason("migration"), true);
  assert.equal(isReviewReason("awaiting_review"), false);
});

test("approving a review merges it, never straight into deploy", () => {
  assert.equal(checkTransition("review", "awaiting_merge").ok, true);
  assert.equal(checkTransition("review", "deploying").ok, false);
  assert.equal(checkTransition("review", "done").ok, false, "a review with no PR is accepted with /complete");
});

test("an older foreman's moves are translated to today's", () => {
  // the migration hold
  assert.deepEqual(resolvePipelineTarget("awaiting_ci", "awaiting_review"), { to: "review", reviewReason: "migration" });
  // the post-deploy sign-off, and merged-with-nothing-to-deploy
  assert.deepEqual(resolvePipelineTarget("verifying", "review"), { to: "done", reviewReason: null });
  assert.deepEqual(resolvePipelineTarget("awaiting_merge", "review"), { to: "done", reviewReason: null });
  // green CI with no auto-deploy is still review; a reason rides along when sent
  assert.deepEqual(resolvePipelineTarget("awaiting_ci", "review"), { to: "review", reviewReason: null });
  assert.deepEqual(resolvePipelineTarget("awaiting_ci", "review", "no_auto_deploy"), { to: "review", reviewReason: "no_auto_deploy" });
  // everything else passes through
  assert.deepEqual(resolvePipelineTarget("awaiting_merge", "deploying"), { to: "deploying", reviewReason: null });
  assert.deepEqual(resolvePipelineTarget("review", "awaiting_merge", "migration"), { to: "awaiting_merge", reviewReason: null });
  // and every translated move is legal from where it starts
  for (const [from, asked] of [["awaiting_ci", "awaiting_review"], ["verifying", "review"], ["awaiting_merge", "review"]] as const) {
    const t = resolvePipelineTarget(from, asked);
    assert.deepEqual(checkTransition(from, t.to, undefined, "human+agent", t.reviewReason), { ok: true }, `${from} -> ${asked}`);
  }
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
  assert.equal(keepRepairOnPatch("in_progress", "rework"), false);
  // The runner's claim reads the fields after moving to in_progress.
  assert.equal(keepRepairOnPatch("queued", "in_progress"), true);
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
  assert.deepEqual(checkTransition("in_progress", "needs_input"), { ok: true });
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
