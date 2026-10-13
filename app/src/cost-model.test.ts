import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUN_BUDGET_CEILING_USD,
  RUN_BUDGET_FLOOR_USD,
  buildCostModel,
  estimateTaskCost,
  runBudgetForEstimate,
  runBudgetForTask,
  type CompletedTaskCost,
} from "./cost-model.js";

const h = (projectId: number, costUsd: number, estimatedEffort: number | null = 2, durationMs: number | null = null): CompletedTaskCost => ({
  projectId,
  costUsd,
  estimatedEffort,
  durationMs,
});

test("with no history at all, every estimate falls back to the configured default", () => {
  const model = buildCostModel([], { defaultTaskCostUsd: 1.25 });
  assert.equal(model.globalMeanUsd, null);
  assert.equal(model.sampleCount, 0);
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: 3 }, model);
  assert.equal(estimate.costUsd, 1.25);
  assert.equal(estimate.basis, "default");
});

test("a project below the sample threshold uses the global mean, not its own", () => {
  const model = buildCostModel([h(1, 10), h(2, 1), h(2, 1), h(2, 1)], { defaultTaskCostUsd: 1.25 });
  // Project 1 has a single (expensive) sample, so it must not get its own mean.
  assert.equal(model.projectMeanUsd.has(1), false);
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: 2 }, model);
  assert.equal(estimate.basis, "global-mean");
  assert.equal(estimate.costUsd, 13 / 4);
});

test("a project with enough history uses its own mean", () => {
  const model = buildCostModel([h(1, 4), h(1, 6), h(1, 5), h(2, 1)], { defaultTaskCostUsd: 1.25 });
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: 2 }, model);
  assert.equal(estimate.basis, "project-mean");
  assert.equal(estimate.costUsd, 5);
});

test("zero and negative costs are ignored rather than dragging the mean down", () => {
  const model = buildCostModel([h(1, 0), h(1, -3), h(1, 2), h(1, 4)], { defaultTaskCostUsd: 1.25 });
  assert.equal(model.sampleCount, 2);
  assert.equal(model.globalMeanUsd, 3);
});

test("effort scaling is off by default even when a $/point rate is computable", () => {
  const model = buildCostModel([h(1, 2, 2), h(1, 4, 4)], { defaultTaskCostUsd: 1.25 });
  assert.equal(model.usdPerEffortPoint, 1);
  assert.equal(model.useEffortScaling, false);
  // Falls through to a mean rather than 1 * 8 = 8.
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: 8 }, model);
  assert.equal(estimate.basis, "global-mean");
  assert.equal(estimate.costUsd, 3);
});

test("effort scaling, once switched on, scales with the task's effort", () => {
  const model = buildCostModel([h(1, 2, 2), h(1, 4, 4)], { defaultTaskCostUsd: 1.25, useEffortScaling: true });
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: 8 }, model);
  assert.equal(estimate.basis, "effort");
  assert.equal(estimate.costUsd, 8);
});

test("effort scaling still falls back for a task that has no effort set", () => {
  const model = buildCostModel([h(1, 2, 2), h(1, 4, 4)], { defaultTaskCostUsd: 1.25, useEffortScaling: true });
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: null }, model);
  assert.equal(estimate.basis, "global-mean");
});

test("mean duration ignores missing and non-positive values", () => {
  const model = buildCostModel([h(1, 1, 2, 1000), h(1, 1, 2, 3000), h(1, 1, 2, null), h(1, 1, 2, 0)], {
    defaultTaskCostUsd: 1.25,
  });
  assert.equal(model.meanDurationMs, 2000);
});

test("mean duration is null when nothing recorded one, so time never caps the plan spuriously", () => {
  const model = buildCostModel([h(1, 1, 2, null)], { defaultTaskCostUsd: 1.25 });
  assert.equal(model.meanDurationMs, null);
});

// the per-run budget cap foreman takes from the gate.

test("runBudgetForEstimate gives an average-sized task real headroom over its estimate", () => {
  assert.equal(runBudgetForEstimate(1.3), 2.6);
  assert.equal(runBudgetForEstimate(3), 6);
});

test("runBudgetForEstimate floors a tiny or cold-start estimate", () => {
  assert.equal(runBudgetForEstimate(0.2), RUN_BUDGET_FLOOR_USD);
  assert.equal(runBudgetForEstimate(0), RUN_BUDGET_FLOOR_USD);
  assert.equal(runBudgetForEstimate(Number.NaN), RUN_BUDGET_FLOOR_USD);
});

// Without a ceiling, a project whose mean is dragged up by a couple of
// expensive tasks would hand every later task a cap big enough to swallow a
// whole 5h session window in one run.
test("runBudgetForEstimate caps a runaway estimate at the ceiling", () => {
  assert.equal(runBudgetForEstimate(40), RUN_BUDGET_CEILING_USD);
  assert.equal(runBudgetForEstimate(5.1), RUN_BUDGET_CEILING_USD);
});

// The concrete regression: a past task needed slightly more than the old
// hardcoded $2 and so could never finish, however many attempts it was given.
test("runBudgetForEstimate clears the wall a past task kept hitting at $2.02", () => {
  assert.ok(runBudgetForEstimate(1.23) > 2.02);
});

// the gate's estimate is the project mean, so without an effort
// floor an effort-8 task got the same ~$2 as a version bump.
test("runBudgetForTask leaves effort 1-2 at the $2 floor", () => {
  assert.equal(runBudgetForTask(0.5, 1), RUN_BUDGET_FLOOR_USD);
  assert.equal(runBudgetForTask(0.5, 2), RUN_BUDGET_FLOOR_USD);
});

test("runBudgetForTask scales with effort 5 and 8", () => {
  assert.equal(runBudgetForTask(0.5, 5), 5);
  assert.equal(runBudgetForTask(0.5, 8), 8);
});

test("runBudgetForTask with no effort keeps the estimate-only budget", () => {
  assert.equal(runBudgetForTask(0.5, null), runBudgetForEstimate(0.5));
  assert.equal(runBudgetForTask(1.3, null), 2.6);
});

test("runBudgetForTask never goes below the estimate budget or above the ceiling", () => {
  assert.equal(runBudgetForTask(3, 2), 6);
  assert.equal(runBudgetForTask(0.5, 13), RUN_BUDGET_CEILING_USD);
});
