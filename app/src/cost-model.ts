// turning a queued task into an estimated $ figure, so the planner
// can decide what fits in a session window and in the period budget.
//
// Effort did not predict cost when first measured (2026-09-16: effort 3 came
// out cheaper than effort 2, nothing done above 3), so the planner used the
// historical mean cost per completed task. Re-measured on 2026-10-13 from
// completed agent tasks with a recorded cost (effortCostTable reproduces this
// from the same history, see cost-model.test.ts):
//
//   effort 1 -> $0.66 (n=11)
//   effort 2 -> $1.12 (n=112)
//   effort 3 -> $1.56 (n=85)
//   effort 5 -> $2.81 (n=46)
//   effort 8 -> $3.77 (n=15)
//
// Cost now rises monotonically with effort, so effort scaling is on by
// default (a planner setting). A $/point line through the origin
// (usdPerEffortPoint) fits it poorly: every run has a fixed overhead, so a
// line with no intercept underestimates effort 1 by about a fifth and
// overestimates effort 8, and the lower the rate the worse effort 1-2 get.
// So a task with effort uses:
//
// 1. the mean of its own effort bucket, when that bucket has
//    MIN_SAMPLES_FOR_EFFORT_BUCKET samples, else
// 2. a least-squares intercept + slope line over every task with effort
//    (about $0.16 + $0.49/point on the data above), which covers sparse
//    buckets like 13.
//
// A task with no effort, or any task while scaling is off, uses the project
// mean (3+ samples), then the global mean, then the configured default. The
// project mean is not applied on top of effort: most projects have too few
// tasks per effort bucket for a per-project, per-effort figure.
//
// Pure on purpose - the DB read lives in plan.ts.

// Below this many completed tasks, a project's own mean is too noisy to
// prefer over the global one. Three is enough to catch "this project is
// consistently much more expensive", while a single outlier task can't
// dominate the whole project's estimate on its own.
export const MIN_SAMPLES_FOR_PROJECT_MEAN = 3;

// Below this many completed tasks at one effort level, that bucket's mean is
// replaced by the intercept + slope line.
export const MIN_SAMPLES_FOR_EFFORT_BUCKET = 5;

export interface CompletedTaskCost {
  projectId: number;
  estimatedEffort: number | null;
  costUsd: number;
  durationMs: number | null;
}

export interface CostModel {
  // Mean cost across every completed task with a recorded cost.
  globalMeanUsd: number | null;
  // Per-project mean, only for projects clearing MIN_SAMPLES_FOR_PROJECT_MEAN.
  projectMeanUsd: Map<number, number>;
  // Mean cost per effort point, global. Computed and reported so the
  // operator can see whether effort has started predicting anything yet;
  // only actually used for estimates when useEffortScaling is on.
  usdPerEffortPoint: number | null;
  // Least-squares line cost = intercept + slope * effort over every task with
  // an effort. Null with fewer than two distinct effort levels.
  effortLine: { interceptUsd: number; slopeUsd: number } | null;
  // Mean cost per effort level, only for levels clearing
  // MIN_SAMPLES_FOR_EFFORT_BUCKET.
  effortBucketMeanUsd: Map<number, number>;
  sampleCount: number;
  // Mean wall-clock duration of a completed task. The planner needs this
  // separately from cost: a 5h window can be capped by time rather than by
  // money (concurrency x 5h only fits so many runs), and knowing which of the
  // two actually binds is most of the value of the plan. Null when nothing
  // has recorded a duration yet.
  meanDurationMs: number | null;
  // What a task with no usable history falls back to.
  defaultTaskCostUsd: number;
  useEffortScaling: boolean;
}

export interface BuildCostModelOptions {
  defaultTaskCostUsd: number;
  useEffortScaling?: boolean;
}

export function buildCostModel(history: readonly CompletedTaskCost[], opts: BuildCostModelOptions): CostModel {
  const usable = history.filter((h) => Number.isFinite(h.costUsd) && h.costUsd > 0);

  const globalMeanUsd = usable.length ? usable.reduce((sum, h) => sum + h.costUsd, 0) / usable.length : null;

  const byProject = new Map<number, number[]>();
  for (const h of usable) {
    const bucket = byProject.get(h.projectId);
    if (bucket) bucket.push(h.costUsd);
    else byProject.set(h.projectId, [h.costUsd]);
  }
  const projectMeanUsd = new Map<number, number>();
  for (const [projectId, costs] of byProject) {
    if (costs.length < MIN_SAMPLES_FOR_PROJECT_MEAN) continue;
    projectMeanUsd.set(projectId, costs.reduce((sum, c) => sum + c, 0) / costs.length);
  }

  const withEffort = usable.filter((h) => h.estimatedEffort !== null && h.estimatedEffort > 0);
  const totalPoints = withEffort.reduce((sum, h) => sum + (h.estimatedEffort as number), 0);
  const usdPerEffortPoint = totalPoints > 0 ? withEffort.reduce((sum, h) => sum + h.costUsd, 0) / totalPoints : null;

  const effortBucketMeanUsd = new Map<number, number>();
  for (const row of effortCostTable(withEffort)) {
    if (row.count >= MIN_SAMPLES_FOR_EFFORT_BUCKET) effortBucketMeanUsd.set(row.effort, row.meanUsd);
  }

  const durations = usable.map((h) => h.durationMs).filter((d): d is number => d !== null && Number.isFinite(d) && d > 0);
  const meanDurationMs = durations.length ? durations.reduce((sum, d) => sum + d, 0) / durations.length : null;

  return {
    globalMeanUsd,
    projectMeanUsd,
    usdPerEffortPoint,
    effortLine: fitEffortLine(withEffort),
    effortBucketMeanUsd,
    sampleCount: usable.length,
    meanDurationMs,
    defaultTaskCostUsd: opts.defaultTaskCostUsd,
    useEffortScaling: opts.useEffortScaling ?? false,
  };
}

export interface EffortCostRow {
  effort: number;
  meanUsd: number;
  count: number;
}

// Mean cost and sample count per effort level, ascending. Tasks with no
// effort or no positive cost are left out. This is the measurement behind
// switching effort scaling on, kept in code so it can be re-checked.
export function effortCostTable(history: readonly CompletedTaskCost[]): EffortCostRow[] {
  const byEffort = new Map<number, number[]>();
  for (const h of history) {
    if (h.estimatedEffort === null || !(h.estimatedEffort > 0) || !Number.isFinite(h.costUsd) || h.costUsd <= 0) continue;
    const bucket = byEffort.get(h.estimatedEffort);
    if (bucket) bucket.push(h.costUsd);
    else byEffort.set(h.estimatedEffort, [h.costUsd]);
  }
  return [...byEffort.entries()]
    .sort(([a], [b]) => a - b)
    .map(([effort, costs]) => ({ effort, meanUsd: costs.reduce((sum, c) => sum + c, 0) / costs.length, count: costs.length }));
}

function fitEffortLine(withEffort: readonly CompletedTaskCost[]): { interceptUsd: number; slopeUsd: number } | null {
  const n = withEffort.length;
  if (n < 2) return null;
  const meanX = withEffort.reduce((sum, h) => sum + (h.estimatedEffort as number), 0) / n;
  const meanY = withEffort.reduce((sum, h) => sum + h.costUsd, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const h of withEffort) {
    const dx = (h.estimatedEffort as number) - meanX;
    sxx += dx * dx;
    sxy += dx * (h.costUsd - meanY);
  }
  if (sxx === 0) return null;
  const slopeUsd = sxy / sxx;
  return { interceptUsd: meanY - slopeUsd * meanX, slopeUsd };
}

export interface EstimatableTask {
  projectId: number;
  estimatedEffort: number | null;
}

export type EstimateBasis = "effort" | "project-mean" | "global-mean" | "default";

export interface CostEstimate {
  costUsd: number;
  basis: EstimateBasis;
}

// Most specific usable basis wins. The basis travels with the number so the
// UI can be honest about how much of the plan is a real measurement versus a
// cold-start guess - a plan built entirely on "default" should not be
// presented with the same confidence as one built on project means.
export function estimateTaskCost(task: EstimatableTask, model: CostModel): CostEstimate {
  if (model.useEffortScaling && task.estimatedEffort !== null && task.estimatedEffort > 0) {
    const bucketMean = model.effortBucketMeanUsd.get(task.estimatedEffort);
    if (bucketMean !== undefined) return { costUsd: bucketMean, basis: "effort" };
    const line = model.effortLine;
    if (line) {
      const fitted = line.interceptUsd + line.slopeUsd * task.estimatedEffort;
      // A noisy fit can slope downwards; never estimate a task at $0 or less.
      if (fitted > 0) return { costUsd: fitted, basis: "effort" };
    }
  }
  const projectMean = model.projectMeanUsd.get(task.projectId);
  if (projectMean !== undefined) return { costUsd: projectMean, basis: "project-mean" };
  if (model.globalMeanUsd !== null) return { costUsd: model.globalMeanUsd, basis: "global-mean" };
  return { costUsd: model.defaultTaskCostUsd, basis: "default" };
}

// the per-run `--max-budget-usd` cap foreman should enforce for a
// given task, derived from that task's own estimate instead of the constant
// (DEFAULT_RUN_OPTIONS.budgetUsd = 2) the runner used to hardcode.
//
// Why a multiple of the estimate rather than the estimate itself: the
// estimate is a *mean*, so roughly half of all runs are expected to exceed
// it. Capping at the mean would fail half the queue by construction. The
// headroom is what makes the cap a runaway-stopper rather than a coin toss.
//
// Why a ceiling at all: without one, a project whose mean is dragged up by a
// couple of expensive tasks would hand every later task a cap big enough to
// swallow an entire 5h session window in one run.
//
// The floor matters most on a cold start, where the estimate is the
// `defaultTaskCostUsd` guess rather than a measurement.
//
// Note this is a *ceiling on waste*, not a spending target - a run that
// finishes in $0.40 still only costs $0.40. It is only ever reached by a run
// that has gone wrong, which is exactly the case #144 exists to stop:
// a past task spent $2.02 against a $2 cap, three times over, because each
// attempt got a fresh cap and none of them could ever finish inside it.
export const RUN_BUDGET_MULTIPLIER = 2;
export const RUN_BUDGET_FLOOR_USD = 2;
export const RUN_BUDGET_CEILING_USD = 10;

export function runBudgetForEstimate(
  estimateUsd: number,
  multiplier = RUN_BUDGET_MULTIPLIER,
  floorUsd = RUN_BUDGET_FLOOR_USD,
  ceilingUsd = RUN_BUDGET_CEILING_USD,
): number {
  if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) return floorUsd;
  return Math.max(floorUsd, Math.min(ceilingUsd, estimateUsd * multiplier));
}

// an effort-based floor under the estimate-derived budget. The
// gate's model ran with useEffortScaling off, so the estimate above was the
// project mean - mostly cheap version bumps - and every task got about $2
// whatever its size. Effort-8 tasks (#477, #375) stopped after scoping; done
// effort-5 tasks have p90 $3.92 and max $5.79. About $1 per effort point
// clears that, and the ceiling still stops a runaway. A task with no effort
// (or effort 1-2) gets exactly what runBudgetForEstimate gives it.
export const RUN_BUDGET_USD_PER_EFFORT_POINT = 1;

export function runBudgetForTask(
  estimateUsd: number,
  estimatedEffort: number | null,
  ceilingUsd = RUN_BUDGET_CEILING_USD,
): number {
  const fromEstimate = runBudgetForEstimate(estimateUsd, RUN_BUDGET_MULTIPLIER, RUN_BUDGET_FLOOR_USD, ceilingUsd);
  if (estimatedEffort === null || !Number.isFinite(estimatedEffort) || estimatedEffort <= 0) return fromEstimate;
  return Math.max(fromEstimate, Math.min(ceilingUsd, estimatedEffort * RUN_BUDGET_USD_PER_EFFORT_POINT));
}
