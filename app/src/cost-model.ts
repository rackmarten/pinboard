// turning a queued task into an estimated $ figure, so the planner
// can decide what fits in a session window and in the period budget.
//
// The obvious model - calibrate $ per effort point off `tasks.estimatedEffort`
// - was measured against real history on 2026-09-16 and does not hold:
//
//   effort 1 -> $0.61 (n=2)
//   effort 2 -> $1.30 (n=23)
//   effort 3 -> $1.23 (n=13)
//
// Effort 3 came out *cheaper* on average than effort 2, and no completed task
// existed at effort 5/8/13 at all. Fitting a $/point line to that is fitting
// noise, and it would make the plan confidently wrong in a way a flat average
// would not be.
//
// So the default estimator is the historical **mean cost per completed task**,
// per project where that project has enough history and globally otherwise.
// Effort is kept in the model behind `useEffortScaling`, off by default, so
// it can be switched on without a rewrite once the data actually shows signal
// (revisit once there are completed tasks at the upper effort levels).
//
// Pure on purpose - the DB read lives in plan.ts.

// Below this many completed tasks, a project's own mean is too noisy to
// prefer over the global one. Three is enough to catch "this project is
// consistently much more expensive", while a single outlier task can't
// dominate the whole project's estimate on its own.
export const MIN_SAMPLES_FOR_PROJECT_MEAN = 3;

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

  const durations = usable.map((h) => h.durationMs).filter((d): d is number => d !== null && Number.isFinite(d) && d > 0);
  const meanDurationMs = durations.length ? durations.reduce((sum, d) => sum + d, 0) / durations.length : null;

  return {
    globalMeanUsd,
    projectMeanUsd,
    usdPerEffortPoint,
    sampleCount: usable.length,
    meanDurationMs,
    defaultTaskCostUsd: opts.defaultTaskCostUsd,
    useEffortScaling: opts.useEffortScaling ?? false,
  };
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
  if (model.useEffortScaling && model.usdPerEffortPoint !== null && task.estimatedEffort !== null && task.estimatedEffort > 0) {
    return { costUsd: model.usdPerEffortPoint * task.estimatedEffort, basis: "effort" };
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
// gate's model runs with useEffortScaling off, so the estimate above is the
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
