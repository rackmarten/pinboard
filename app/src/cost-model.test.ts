import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RUN_BUDGET_CEILING_USD,
  RUN_BUDGET_FLOOR_USD,
  MIN_SAMPLES_FOR_EFFORT_BUCKET,
  buildCostModel,
  effortCostTable,
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

// The 2026-10-13 measurement that switched effort scaling on: completed agent
// tasks with a recorded cost, by effort. Each bucket is spread +-30% around its
// mean so the fixture is not a set of identical values.
const MEASURED: ReadonlyArray<{ effort: number; meanUsd: number; count: number }> = [
  { effort: 1, meanUsd: 0.66, count: 11 },
  { effort: 2, meanUsd: 1.12, count: 112 },
  { effort: 3, meanUsd: 1.56, count: 85 },
  { effort: 5, meanUsd: 2.81, count: 46 },
  { effort: 8, meanUsd: 3.77, count: 15 },
];

function measuredHistory(): CompletedTaskCost[] {
  const out: CompletedTaskCost[] = [];
  for (const { effort, meanUsd, count } of MEASURED) {
    for (let i = 0; i < count; i++) {
      // Pairs at mean*(1-0.3) and mean*(1+0.3); an odd one out sits on the mean.
      const spread = i === count - 1 && count % 2 === 1 ? 0 : i % 2 === 0 ? -0.3 : 0.3;
      out.push(h(1 + (i % 4), meanUsd * (1 + spread), effort));
    }
  }
  return out;
}

const cents = (n: number) => Math.round(n * 100) / 100;

test("effortCostTable reproduces the measurement, and cost rises with effort", () => {
  const table = effortCostTable([...measuredHistory(), h(1, 5, null), h(1, 0, 2)]);
  assert.deepEqual(
    table.map((r) => ({ effort: r.effort, meanUsd: cents(r.meanUsd), count: r.count })),
    MEASURED,
  );
  for (let i = 1; i < table.length; i++) assert.ok(table[i].meanUsd > table[i - 1].meanUsd);
});

test("intercept + slope fits the measured data better than a $/point line through the origin", () => {
  const model = buildCostModel(measuredHistory(), { defaultTaskCostUsd: 1.25 });
  const perPoint = model.usdPerEffortPoint as number;
  const line = model.effortLine!;
  const worst = (predict: (effort: number) => number) =>
    Math.max(...MEASURED.map(({ effort, meanUsd }) => Math.abs(predict(effort) - meanUsd) / meanUsd));
  const originError = worst((e) => perPoint * e);
  const lineError = worst((e) => line.interceptUsd + line.slopeUsd * e);
  // The origin line misses effort 1 by about a fifth; the fitted line stays within 10% everywhere.
  assert.ok(originError > 0.15, `origin line worst error ${originError}`);
  assert.ok(lineError < 0.1, `fitted line worst error ${lineError}`);
});

test("with scaling on, each measured effort bucket is estimated at its own mean", () => {
  const model = buildCostModel(measuredHistory(), { defaultTaskCostUsd: 1.25, useEffortScaling: true });
  for (const { effort, meanUsd } of MEASURED) {
    const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: effort }, model);
    assert.equal(estimate.basis, "effort");
    assert.equal(cents(estimate.costUsd), meanUsd, `effort ${effort}`);
  }
});

test("an effort level with no bucket uses the intercept + slope line, which fits the measured data", () => {
  const model = buildCostModel(measuredHistory(), { defaultTaskCostUsd: 1.25, useEffortScaling: true });
  const line = model.effortLine!;
  assert.ok(line.interceptUsd > 0 && line.slopeUsd > 0);
  for (const { effort, meanUsd } of MEASURED) {
    const fitted = line.interceptUsd + line.slopeUsd * effort;
    assert.ok(Math.abs(fitted - meanUsd) / meanUsd < 0.1, `effort ${effort}: line ${fitted} vs mean ${meanUsd}`);
  }
  const e13 = estimateTaskCost({ projectId: 1, estimatedEffort: 13 }, model);
  assert.equal(e13.basis, "effort");
  assert.equal(e13.costUsd, line.interceptUsd + line.slopeUsd * 13);
  assert.ok(e13.costUsd > estimateTaskCost({ projectId: 1, estimatedEffort: 8 }, model).costUsd);
});

test("an effort bucket below the sample threshold uses the line instead of its own mean", () => {
  const history = [
    ...Array.from({ length: MIN_SAMPLES_FOR_EFFORT_BUCKET }, () => h(1, 1, 1)),
    ...Array.from({ length: MIN_SAMPLES_FOR_EFFORT_BUCKET }, () => h(1, 3, 3)),
    ...Array.from({ length: MIN_SAMPLES_FOR_EFFORT_BUCKET - 1 }, () => h(1, 50, 2)),
  ];
  const model = buildCostModel(history, { defaultTaskCostUsd: 1.25, useEffortScaling: true });
  assert.equal(model.effortBucketMeanUsd.has(2), false);
  const line = model.effortLine!;
  assert.equal(estimateTaskCost({ projectId: 1, estimatedEffort: 2 }, model).costUsd, line.interceptUsd + line.slopeUsd * 2);
});

test("with scaling on, a task with no effort keeps the flat mean", () => {
  const history = measuredHistory();
  const model = buildCostModel(history, { defaultTaskCostUsd: 1.25, useEffortScaling: true });
  const own = history.filter((r) => r.projectId === 1);
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: null }, model);
  assert.equal(estimate.basis, "project-mean");
  assert.equal(estimate.costUsd, own.reduce((sum, r) => sum + r.costUsd, 0) / own.length);
  const unknownProject = estimateTaskCost({ projectId: 99, estimatedEffort: null }, model);
  assert.equal(unknownProject.basis, "global-mean");
  assert.equal(unknownProject.costUsd, model.globalMeanUsd);
});

test("with scaling off, effort is ignored even on the measured data", () => {
  const model = buildCostModel(measuredHistory(), { defaultTaskCostUsd: 1.25, useEffortScaling: false });
  const e1 = estimateTaskCost({ projectId: 99, estimatedEffort: 1 }, model);
  const e8 = estimateTaskCost({ projectId: 99, estimatedEffort: 8 }, model);
  assert.equal(e1.basis, "global-mean");
  assert.equal(e1.costUsd, e8.costUsd);
});

test("a line that slopes down never estimates a task at $0 or less", () => {
  const model = buildCostModel([h(1, 5, 1), h(1, 0.1, 13)], { defaultTaskCostUsd: 1.25, useEffortScaling: true });
  const estimate = estimateTaskCost({ projectId: 1, estimatedEffort: 21 }, model);
  assert.notEqual(estimate.basis, "effort");
  assert.ok(estimate.costUsd > 0);
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
