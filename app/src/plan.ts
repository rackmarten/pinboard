// the work plan. Answers three questions the %-based governor
// could not:
//
//   1. What can actually run right now, given the $ left in the open 5h
//      window and the concurrency/conflict rules?
//   2. What does the rest of the period look like if we keep going?
//   3. Is there enough queued work to spend the budget at all?
//
// (3) is the one that turned out to matter most in practice: on 2026-09-16
// the queue held 5 tasks worth roughly $6 against roughly $50 remaining, so
// the honest answer to "how should I pace this" was "file more tasks", not
// "throttle".
//
// The pure computation is split out from the DB reads below it so every
// boundary rule (pacing, packing, the load verdict) is unit-testable without
// a database - same split session-windows.ts and cost-model.ts already use.

import { and, desc, eq, gt, gte, lt, sql as dsql } from "drizzle-orm";
import { config } from "./config.js";
import { db, sql } from "./db/client.js";
import { agents, budgetPeriods, sessionLimitReports, tasks, usageEvents } from "./db/schema.js";
import {
  RUN_BUDGET_FLOOR_USD,
  buildCostModel,
  estimateTaskCost,
  runBudgetForTask,
  type CostModel,
  type EstimateBasis,
} from "./cost-model.js";
import { getDefaultLicenseId, getLicense, getLicenseSettings } from "./licenses.js";
import { getPlannerSettings, type PlannerSettings } from "./settings.js";
import { ROOT_LABEL } from "./root-grants.js";
import { countsTowardBudgetGate, UNGATED_USAGE_SOURCES, type UsageSource } from "./usage.js";
import { describeRecurrence, dbRecurrenceStore, ensureRecurringPeriod } from "./recurrence.js";
import {
  SESSION_WINDOW_MS,
  deriveSessionWindows,
  planSlots,
  sessionWindowState,
  type CostEvent,
  type PlannedSlot,
  type SessionWindowState,
} from "./session-windows.js";

// Mirrors foreman's runner.ts MAX_AUTONOMY_LEVEL. Duplicated rather than
// shared because foreman is the one that enforces it at spawn time and
// pinboard is the one that has to predict what foreman will accept - if that
// ceiling ever moves, both sides have to move together anyway.
export const MAX_AUTONOMY_LEVEL = 3;

// How far out to read cost events when deriving session windows. Only the
// most recent window can possibly still be open, so anything older than two
// windows is irrelevant to the gate - but the period's own spend is summed
// separately over the whole period, so this bound doesn't affect it.
const SESSION_LOOKBACK_MS = SESSION_WINDOW_MS * 2;

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

export interface RunnableTask {
  id: number;
  projectId: number;
  title: string;
  status: string;
  priority: number;
  executorMode: string;
  // Optional so callers built before a past task still type-check; a story
  // groups increments and is never run itself, even if queued.
  taskType?: string;
  autonomyLevel: number | null;
  estimatedEffort: number | null;
  createdAt: string;
}

// The same ordering and eligibility foreman's rankRunnableTasks applies, so
// the plan predicts what the dispatcher will actually do rather than a
// parallel opinion of it. `/tasks?status=queued` comes back priority desc,
// createdAt desc (tuned for the human task list, newest first); a queue wants
// oldest-first among equal priorities, hence the re-sort.
export function rankRunnableTasks<T extends RunnableTask>(queued: readonly T[], blockedIds: ReadonlySet<number>): T[] {
  return [...queued]
    .filter(
      (t) =>
        (t.executorMode === "agent" || t.executorMode === "human+agent") &&
        t.taskType !== "story" &&
        t.autonomyLevel !== null &&
        t.autonomyLevel <= MAX_AUTONOMY_LEVEL &&
        !blockedIds.has(t.id),
    )
    .sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.createdAt.localeCompare(b.createdAt)));
}

// A past task removed the repo-set conflict rule that used to live here. It
// existed because two agents on one repo shared a git checkout (foreman put
// every run in a worktree inside the workspace clone); a run now gets its own
// clone of every repo it may write to, under /app/tasks/task-<id>, so two
// tasks on one repo no longer touch the same files at all. The one step that
// still must not overlap, deploying a service, is serialised by foreman's own
// per-repo deploy lock (see foreman's app/src/workdir.ts).

export type PacingMode = "unthrottled" | "throttled";

export interface Pace {
  mode: PacingMode;
  // The $ ceiling the planner will allow any single 5h slot to consume.
  perSlotUsd: number;
  slotCount: number;
}

// Adaptive pacing, per the operator's choice: don't slow anything down while
// the queue's total estimated cost still fits inside the remaining budget -
// there is nothing to protect the budget from. Only once the queue could
// burn the budget before the period ends does it spread spend evenly across
// the slots that remain.
//
// Either way the session cap is an absolute ceiling: a slot can never be
// allowed more than one 5h window's worth of spend.
export function computePace(remainingBudgetUsd: number, queueCostUsd: number, slotCount: number, sessionCapUsd: number): Pace {
  if (slotCount <= 0) return { mode: "unthrottled", perSlotUsd: 0, slotCount: 0 };
  if (queueCostUsd <= remainingBudgetUsd) {
    return { mode: "unthrottled", perSlotUsd: sessionCapUsd, slotCount };
  }
  return {
    mode: "throttled",
    perSlotUsd: Math.min(sessionCapUsd, remainingBudgetUsd / slotCount),
    slotCount,
  };
}

// How many task-runs fit in a slot on wall-clock alone: a 5h window running
// `concurrency` at a time, at the historical mean task duration. Unbounded
// (Infinity) when nothing has recorded a duration yet, so the budget stays
// the only constraint rather than time silently capping the plan at zero.
export function slotTimeCapacity(slotMs: number, concurrency: number, meanDurationMs: number | null): number {
  if (meanDurationMs === null || meanDurationMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((slotMs * concurrency) / meanDurationMs));
}

export type BindingConstraint = "budget" | "time" | "queue" | "none";

export interface PlannedTask {
  taskId: number;
  title: string;
  projectId: number;
  priority: number;
  estimatedCostUsd: number;
  estimateBasis: EstimateBasis;
  // True for a task already executing - it is shown in the open slot for
  // context but was never "placed" by the packer.
  running: boolean;
}

export interface PlanSlotResult {
  startsAt: string;
  endsAt: string;
  hypothetical: boolean;
  // The $ this slot may still take: the session cap (less anything already
  // spent in it) further limited by the pace and by what's left of the
  // period budget once earlier slots have taken their share.
  capUsd: number;
  spentUsd: number;
  plannedUsd: number;
  availableUsd: number;
  timeCapacity: number | null;
  tasks: PlannedTask[];
}

export interface PlanLoad {
  queueCostUsd: number;
  remainingBudgetUsd: number;
  // Share of the remaining budget the queue can actually absorb. 1 means the
  // queue is worth exactly the budget; below 1 there is money with no work
  // to spend it on.
  coverage: number;
  verdict: "underloaded" | "balanced" | "overloaded" | "unknown";
  // Budget that no queued task can be placed against before the period ends.
  unspendableUsd: number;
  idleSlots: number;
  runnableTaskCount: number;
  // Runnable tasks that did not fit before the period ends.
  deferredTaskCount: number;
  // Queued, agent-eligible tasks held back only by an unfinished depends_on.
  // Reported separately because "0 runnable" with a visibly non-empty queue
  // otherwise reads as a bug - the queue being entirely blocked behind one
  // running task is a normal and common state here, and it calls for a very
  // different response (unblock it) than an actually empty queue (file more).
  blockedTaskCount: number;
}

// Below this much coverage there is meaningfully more money than work; above
// the upper bound the queue can't be finished in the period. Between them the
// queue and the budget are a reasonable match and neither needs attention.
export const UNDERLOAD_COVERAGE = 0.75;
export const OVERLOAD_COVERAGE = 1.25;

export function loadVerdict(queueCostUsd: number, remainingBudgetUsd: number): PlanLoad["verdict"] {
  if (remainingBudgetUsd <= 0) return "unknown";
  const coverage = queueCostUsd / remainingBudgetUsd;
  if (coverage < UNDERLOAD_COVERAGE) return "underloaded";
  if (coverage > OVERLOAD_COVERAGE) return "overloaded";
  return "balanced";
}

export interface PackInput {
  slots: readonly PlannedSlot[];
  ranked: readonly RunnableTask[];
  running: readonly PlannedTask[];
  estimate: (task: RunnableTask) => { costUsd: number; basis: EstimateBasis };
  pace: Pace;
  sessionCapUsd: number;
  remainingBudgetUsd: number;
  concurrency: number;
  meanDurationMs: number | null;
}

export interface PackResult {
  slots: PlanSlotResult[];
  deferred: RunnableTask[];
  binding: BindingConstraint;
}

// Greedy, in rank order, earliest slot first. Deliberately simple: the plan
// is a forecast that is recomputed on every read, not a schedule anything
// commits to, so there is no value in packing optimally - and a greedy pass
// in rank order is the one that actually matches what the dispatcher will do
// when it keeps asking "what's next".
//
export function packPlan(input: PackInput): PackResult {
  const { slots, ranked, running, estimate, pace, sessionCapUsd, remainingBudgetUsd, concurrency, meanDurationMs } = input;

  const placed = new Set<number>();
  const result: PlanSlotResult[] = [];
  let budgetLeft = remainingBudgetUsd;
  let hitBudget = false;
  let hitTime = false;

  for (const slot of slots) {
    const slotMs = slot.endsAt.getTime() - slot.startsAt.getTime();
    const capacity = slotTimeCapacity(slotMs, concurrency, meanDurationMs);
    // The open slot has already spent some of its own window cap.
    const sessionRoom = Math.max(0, sessionCapUsd - slot.spentUsd);
    const capUsd = Math.max(0, Math.min(sessionRoom, pace.perSlotUsd, budgetLeft));

    // Running work belongs in the first slot whether or not a session window
    // is actually open. A window only opens once cost *lands*, and a run's
    // cost lands when it finishes - so a task can legitimately be executing
    // with no open window, and showing nothing as running in that state reads
    // as "nothing is happening" when something very much is.
    const slotTasks: PlannedTask[] = result.length === 0 ? [...running] : [];
    let plannedUsd = 0;
    let runsPlaced = slotTasks.length;

    for (const task of ranked) {
      if (placed.has(task.id)) continue;
      if (runsPlaced >= capacity) {
        hitTime = true;
        break;
      }
      const { costUsd, basis } = estimate(task);
      if (plannedUsd + costUsd > capUsd) {
        // Don't skip ahead to a cheaper task: rank order is the operator's
        // stated override lever (bump a priority to pull work forward), and
        // letting a cheap low-priority task jump a queue-head that merely
        // doesn't fit this slot would quietly defeat that.
        if (capUsd < remainingBudgetUsd) hitBudget = true;
        break;
      }
      plannedUsd += costUsd;
      runsPlaced += 1;
      placed.add(task.id);
      slotTasks.push({
        taskId: task.id,
        title: task.title,
        projectId: task.projectId,
        priority: task.priority,
        estimatedCostUsd: costUsd,
        estimateBasis: basis,
        running: false,
      });
    }

    budgetLeft = Math.max(0, budgetLeft - plannedUsd);
    result.push({
      startsAt: slot.startsAt.toISOString(),
      endsAt: slot.endsAt.toISOString(),
      hypothetical: slot.hypothetical,
      capUsd,
      spentUsd: slot.spentUsd,
      plannedUsd,
      availableUsd: Math.max(0, capUsd - plannedUsd),
      timeCapacity: Number.isFinite(capacity) ? capacity : null,
      tasks: slotTasks,
    });
  }

  const deferred = ranked.filter((t) => !placed.has(t.id));

  // What actually stopped the plan from holding more work. "queue" - and it
  // is the common case here - means nothing stopped it: every runnable task
  // was placed and there was room to spare.
  let binding: BindingConstraint = "none";
  if (deferred.length === 0) binding = "queue";
  else if (budgetLeft <= 0 || hitBudget) binding = "budget";
  else if (hitTime) binding = "time";

  return { slots: result, deferred, binding };
}

export interface StartableResult {
  tasks: PlannedTask[];
  // Set when the right move is to wait rather than to start anything: the
  // session cap is spent but its window hasn't expired yet. Callers (foreman)
  // should sleep until this rather than re-polling into the same refusal.
  waitUntil: string | null;
  reason: string | null;
}

// What may start at this exact moment. This is the real gate - the rest of
// the plan is a forecast, but this is the answer foreman acts on.
//
// Applies, in order: the period budget, the open session window's remaining
// $, and the concurrency limits (global and this seat's own).
export function startableNow(input: {
  ranked: readonly RunnableTask[];
  running: readonly { taskId: number }[];
  estimate: (task: RunnableTask) => { costUsd: number; basis: EstimateBasis };
  sessionRemainingUsd: number;
  sessionResetsAt: Date | null;
  // true when the window is closed because Claude itself said so
  // (a reported session limit), rather than because the configured $ cap was
  // spent. Only affects the refusal string, but that string is the main
  // diagnostic surface for "why is the dispatcher asleep?" - and "budget is
  // spent" is actively misleading when nothing was spent at all.
  sessionLimitReported?: boolean;
  periodRemainingUsd: number;
  periodConfigured: boolean;
  concurrency: number;
  // the asking license's own limit and how much of it that license
  // is already using. Both caps apply: the global one stops the system running
  // too many paid agents at once whoever owns them, the seat one stops one
  // seat taking the whole allowance. Defaults keep a caller that doesn't know
  // about seats behaving exactly as it did (seat limit = global limit, none of
  // it used).
  seatConcurrency?: number;
  seatRunning?: number;
  // the operator's explicit "run it anyway". Skips the *budget*
  // gates (period and session window) only. Concurrency is never bypassable:
  // it stops the system running more paid agents at once than the operator
  // allowed, whereas overspending is a decision the operator is entitled to
  // make.
  override?: boolean;
}): StartableResult {
  const {
    ranked,
    running,
    estimate,
    sessionRemainingUsd,
    sessionResetsAt,
    sessionLimitReported = false,
    periodRemainingUsd,
    periodConfigured,
    concurrency,
    seatConcurrency = concurrency,
    seatRunning = 0,
    override = false,
  } = input;

  if (!periodConfigured && !override) {
    return { tasks: [], waitUntil: null, reason: "no budget period covers right now - set one to plan or run anything" };
  }
  if (periodRemainingUsd <= 0 && !override) {
    return { tasks: [], waitUntil: null, reason: "period budget is exhausted - raise it or wait for the next period" };
  }
  // Before the concurrency check: a spent window is the fact that matters
  // even when the seat is also full. Checked after, a seat whose only slot is
  // held by the run that hit the limit read "concurrency limit reached" and
  // the plan never showed the wait.
  if (sessionRemainingUsd <= 0 && !override) {
    return {
      tasks: [],
      waitUntil: sessionResetsAt ? sessionResetsAt.toISOString() : null,
      reason: sessionLimitReported
        ? "Claude reported the 5h session limit - waiting for the window it named to reset"
        : "session window budget is spent - waiting for the window to expire",
    };
  }
  const globalFree = concurrency - running.length;
  const seatFree = seatConcurrency - seatRunning;
  const slotsFree = Math.min(globalFree, seatFree);
  if (slotsFree <= 0) {
    // Name the limit that actually bit. "concurrency limit reached" while the
    // global count plainly has room reads as a bug, and the two have very
    // different remedies - raise this seat's limit vs. raise the global one.
    // When both are full, say so: raising only one of them would look like it
    // did nothing.
    const reason =
      seatFree <= 0 && globalFree <= 0
        ? `concurrency limit (${concurrency}) reached, and this license's own limit (${seatConcurrency}) too`
        : seatFree <= 0
          ? `this license's concurrency limit (${seatConcurrency}) reached`
          : `concurrency limit (${concurrency}) reached`;
    return { tasks: [], waitUntil: null, reason };
  }

  const taken: PlannedTask[] = [];
  // With an override there is no budget ceiling to pack against - the
  // operator has said to run it regardless of what it costs.
  let budget = override ? Number.POSITIVE_INFINITY : Math.min(sessionRemainingUsd, periodRemainingUsd);

  // Why each candidate was passed over, so the refusal can name the actual
  // obstacle. These strings are the main diagnostic surface for a system that
  // is otherwise opaque - they land in foreman's dispatch log and in `work
  // plan status`.
  let sawTooExpensive = false;

  for (const task of ranked) {
    if (taken.length >= slotsFree) break;
    const { costUsd, basis } = estimate(task);
    if (costUsd > budget) {
      sawTooExpensive = true;
      continue;
    }

    taken.push({
      taskId: task.id,
      title: task.title,
      projectId: task.projectId,
      priority: task.priority,
      estimatedCostUsd: costUsd,
      estimateBasis: basis,
      running: false,
    });
    budget -= costUsd;
  }

  if (taken.length === 0) {
    // Separate messages: an empty ranked list means there is simply nothing
    // eligible to run (usually everything queued is behind a dependency),
    // which is a very different situation from having candidates that don't
    // fit. This string ends up in foreman's dispatch log, so the distinction
    // is worth keeping.
    const reason =
      ranked.length === 0
        ? "nothing runnable in the queue"
        : sawTooExpensive
          ? "no runnable task fits the remaining budget"
          : "nothing startable right now";
    return { tasks: [], waitUntil: null, reason };
  }
  return { tasks: taken, waitUntil: null, reason: null };
}

// ---------------------------------------------------------------------------
// DB glue
// ---------------------------------------------------------------------------

export interface BudgetPeriod {
  id: number;
  startsAt: string;
  endsAt: string;
  budgetUsd: number;
  note: string | null;
  licenseId: number;
  createdAt: string;
}

function rowToPeriod(row: typeof budgetPeriods.$inferSelect): BudgetPeriod {
  return {
    id: row.id,
    startsAt: toIso(row.startsAt),
    endsAt: toIso(row.endsAt),
    budgetUsd: Number(row.budgetUsd),
    note: row.note,
    licenseId: row.licenseId,
    createdAt: toIso(row.createdAt),
  };
}

function toIso(value: unknown): string {
  return (value as Date)?.toISOString?.() ?? String(value);
}

// licenseId is an optional filter (an operator overview may want every
// license's periods at once); the planner itself always passes one - see
// getCurrentBudgetPeriod.
export async function listBudgetPeriods(limit = 20, licenseId?: number): Promise<BudgetPeriod[]> {
  const rows = await db
    .select()
    .from(budgetPeriods)
    .where(licenseId !== undefined ? eq(budgetPeriods.licenseId, licenseId) : undefined)
    .orderBy(desc(budgetPeriods.startsAt))
    .limit(limit);
  return rows.map(rowToPeriod);
}

// The period containing `now`, scoped to one license - budgets are fully
// separate per license (schema.ts's budgetPeriods note), not a shared pool.
// Periods aren't required to be contiguous, so a null here just means no
// budget was set for this license for this stretch - the planner reports
// that as unconfigured rather than assuming a number.
//
// when nothing covers `now` and the license repeats weekly, the
// missing week is inserted here (recurrence.ts), so every reader of the
// current period gets the rollover without a timer.
export async function getCurrentBudgetPeriod(licenseId: number, now = new Date()): Promise<BudgetPeriod | null> {
  const covering = async () => {
    const [row] = await db
      .select()
      .from(budgetPeriods)
      .where(and(eq(budgetPeriods.licenseId, licenseId), lt(budgetPeriods.startsAt, now), gte(budgetPeriods.endsAt, now)))
      .orderBy(desc(budgetPeriods.startsAt))
      .limit(1);
    return row ? rowToPeriod(row) : null;
  };
  const found = await covering();
  if (found) return found;
  // A concurrent caller may have inserted it instead of us, so re-read rather
  // than relying on the return value.
  return (await ensureRecurringPeriod(dbRecurrenceStore, licenseId, now)) ? covering() : null;
}

// The recurrence anchor: the license's latest period's end.
export async function latestBudgetPeriodEnd(licenseId: number): Promise<Date | null> {
  const [row] = await db
    .select({ endsAt: budgetPeriods.endsAt })
    .from(budgetPeriods)
    .where(eq(budgetPeriods.licenseId, licenseId))
    .orderBy(desc(budgetPeriods.endsAt))
    .limit(1);
  return row ? row.endsAt : null;
}

export async function createBudgetPeriod(
  budgetUsd: number,
  endsAt: Date,
  licenseId: number,
  startsAt?: Date,
  note?: string,
): Promise<BudgetPeriod> {
  const [row] = await db
    .insert(budgetPeriods)
    .values({ budgetUsd: String(budgetUsd), endsAt, licenseId, startsAt, note })
    .returning();
  return rowToPeriod(row);
}

export async function updateBudgetPeriod(
  id: number,
  patch: { budgetUsd?: number; endsAt?: Date; startsAt?: Date; note?: string | null },
): Promise<BudgetPeriod | null> {
  const values: Record<string, unknown> = {};
  if (patch.budgetUsd !== undefined) values.budgetUsd = String(patch.budgetUsd);
  if (patch.endsAt !== undefined) values.endsAt = patch.endsAt;
  if (patch.startsAt !== undefined) values.startsAt = patch.startsAt;
  if (patch.note !== undefined) values.note = patch.note;
  if (Object.keys(values).length === 0) {
    const [row] = await db.select().from(budgetPeriods).where(eq(budgetPeriods.id, id));
    return row ? rowToPeriod(row) : null;
  }
  const [row] = await db.update(budgetPeriods).set(values).where(eq(budgetPeriods.id, id)).returning();
  return row ? rowToPeriod(row) : null;
}

// Append-only - see schema.ts's usageEvents note. Called from the handoff and
// chat-usage routes rather than replacing what either already writes.
// licenseId is required (schema.ts's note on why it's denormalized here at
// write time rather than joined through agents.licenseId later) - callers
// resolve it from the spending agent, falling back to the default license
// (licenses.ts's getDefaultLicenseId) when there is no agent to resolve one
// from.
//
// Returns the new row's id, or null when nothing was written (no spend).
export async function recordUsageEvent(input: {
  costUsd: number;
  source: UsageSource;
  licenseId: number;
  taskId?: number | null;
  chatThreadId?: number | null;
  handoffId?: number | null;
  occurredAt?: Date;
}): Promise<number | null> {
  if (!Number.isFinite(input.costUsd) || input.costUsd <= 0) return null;
  const [row] = await db
    .insert(usageEvents)
    .values({
      costUsd: String(input.costUsd),
      source: input.source,
      licenseId: input.licenseId,
      taskId: input.taskId ?? null,
      chatThreadId: input.chatThreadId ?? null,
      handoffId: input.handoffId ?? null,
      occurredAt: input.occurredAt,
    })
    .returning({ id: usageEvents.id });
  return row?.id ?? null;
}

async function sumUsageBetween(start: Date, end: Date, licenseId: number): Promise<number> {
  const [row] = await sql<{ total: string | null }[]>`
    select coalesce(sum(cost_usd::numeric), 0) as total
    from usage_events
    where occurred_at >= ${start.toISOString()} and occurred_at <= ${end.toISOString()}
      and license_id = ${licenseId}
      and source <> all(${UNGATED_USAGE_SOURCES as string[]})
  `;
  return Number(row?.total ?? 0);
}

async function recentCostEvents(since: Date, licenseId: number): Promise<CostEvent[]> {
  const rows = await db
    .select({ occurredAt: usageEvents.occurredAt, costUsd: usageEvents.costUsd, source: usageEvents.source })
    .from(usageEvents)
    .where(and(gte(usageEvents.occurredAt, since), eq(usageEvents.licenseId, licenseId)));
  return rows.filter((r) => countsTowardBudgetGate(r.source)).map((r) => ({ occurredAt: r.occurredAt as unknown as Date, costUsd: Number(r.costUsd) }));
}

// the most recent session-limit report for this license whose
// reset has not yet passed, or null. Only the newest matters - an older
// report either names the same boundary or a boundary already behind us,
// and either way the newest one is what Claude said last.
//
// Returning null once the reset has passed is deliberate: the report's whole
// job is to say "not before T", so after T it carries no information and the
// derived windows take over again.
//
// `ignoreBefore` is the license's manual session reset: a report made before
// it is one the operator has explicitly said is stale.
export async function liveSessionLimitReset(licenseId: number, now: Date, ignoreBefore: Date | null = null): Promise<Date | null> {
  const [row] = await db
    .select({ resetsAt: sessionLimitReports.resetsAt })
    .from(sessionLimitReports)
    .where(
      and(
        eq(sessionLimitReports.licenseId, licenseId),
        gte(sessionLimitReports.resetsAt, now),
        ignoreBefore ? gt(sessionLimitReports.reportedAt, ignoreBefore) : undefined,
      ),
    )
    .orderBy(desc(sessionLimitReports.reportedAt))
    .limit(1);
  return row ? (row.resetsAt as unknown as Date) : null;
}

// Tasks with an unfinished `depends_on` - the same gate foreman applies, but
// resolved for the whole queue in one query instead of one round trip per
// task the way its runner does it. a target in `review` with
// every PR merged counts as finished (task-model.ts's dependencySatisfied()
// is the same rule in TS).
async function blockedTaskIds(): Promise<Set<number>> {
  const rows = await sql<{ from_task_id: number }[]>`
    select distinct r.from_task_id
    from task_relations r
    join tasks t on t.id = r.to_task_id
    where r.relation_type = 'depends_on'
      and t.status not in ('done', 'rejected')
      and not (
        t.status = 'review'
        and exists (select 1 from pull_requests p where p.task_id = t.id)
        and not exists (select 1 from pull_requests p where p.task_id = t.id and p.state <> 'merged')
      )
  `;
  return new Set(rows.map((r) => r.from_task_id));
}

export interface PlanResult {
  generatedAt: string;
  period: {
    configured: boolean;
    id: number | null;
    startsAt: string | null;
    endsAt: string | null;
    budgetUsd: number;
    spentUsd: number;
    remainingUsd: number;
    hoursRemaining: number;
    // this seat's weekly recurrence, so the PWA can show "repeats
    // weekly, next reset <date>". See recurrence.ts's describeRecurrence.
    recurrence: { enabled: boolean; budgetUsd: number | null; nextEndsAt: string | null };
  };
  sessionWindow: {
    openStartsAt: string | null;
    endsAt: string | null;
    capUsd: number;
    spentUsd: number;
    remainingUsd: number;
    exhausted: boolean;
  };
  pace: Pace;
  binding: BindingConstraint;
  slots: PlanSlotResult[];
  load: PlanLoad;
  costModel: {
    globalMeanUsd: number | null;
    usdPerEffortPoint: number | null;
    effortLine: { interceptUsd: number; slopeUsd: number } | null;
    // Per-effort-level mean cost, for levels with enough samples to be used.
    effortMeans: Array<{ effort: number; meanUsd: number }>;
    meanDurationMs: number | null;
    sampleCount: number;
    useEffortScaling: boolean;
  };
  settings: PlannerSettings;
  // both caps, reported separately because they have different
  // remedies when one of them is what's holding work back - `seat` is this
  // license's own limit (its override, else the global default), `seatRunning`
  // how much of it this license is already using.
  concurrency: { global: number; seat: number; seatRunning: number };
  startable: StartableResult;
}

async function loadPlannerInputs(licenseId: number, now: Date) {
  const [settings, licenseSettings, period, license] = await Promise.all([
    getPlannerSettings(),
    getLicenseSettings(licenseId),
    getCurrentBudgetPeriod(licenseId, now),
    getLicense(licenseId),
  ]);

  // The operator's manual session reset: spend before it no longer counts
  // toward the session window (the period budget still counts all of it).
  const lookbackStart = new Date(now.getTime() - SESSION_LOOKBACK_MS);
  const sessionResetAt = license?.sessionResetAt ? new Date(license.sessionResetAt) : null;
  const sessionSince = sessionResetAt && sessionResetAt > lookbackStart ? sessionResetAt : lookbackStart;

  const periodStart = period ? new Date(period.startsAt) : now;
  const periodEnd = period ? new Date(period.endsAt) : now;

  const [spentUsd, events, reportedResetAt, blocked, queuedRows, executingActors, historyRows] = await Promise.all([
    period ? sumUsageBetween(periodStart, now, licenseId) : Promise.resolve(0),
    recentCostEvents(sessionSince, licenseId),
    liveSessionLimitReset(licenseId, now, sessionResetAt),
    blockedTaskIds(),
    // a queued `root-access` task is only runnable while its root
    // grant is live. One whose grant expired (or was revoked) while it sat
    // in the queue waits for the operator to grant it again.
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "queued"),
          dsql`(not exists (
            select 1 from task_labels tl join labels l on l.id = tl.label_id
            where tl.task_id = ${tasks.id} and l.name = ${ROOT_LABEL}
          ) or (${tasks.rootGrantExpiresAt} > now() and cardinality(${tasks.rootGrantCtids}) > 0))`,
        ),
      ),
    // a task's latest claim tells us whether a *human* or an agent
    // holds it. The distinction matters: a human working a task by hand does
    // not consume an agent concurrency slot - that limit exists to stop the
    // system spawning too many paid agents at once. Same join
    // getExecutingSnapshot uses, for the same reason: `tasks` carries no
    // "current actor" column.
    sql<{ id: number; actor_type: string | null; actor_name: string | null }[]>`
      select t.id, ev.actor_type, ev.actor_name
      from tasks t
      left join lateral (
        select actor_type, actor_name from task_events
        where task_id = t.id and event_type = 'claim'
        order by created_at desc limit 1
      ) ev on true
      where t.status = 'executing'
    `,
    sql<{ project_id: number; estimated_effort: number | null; cost_usd: string; duration_ms: number | null }[]>`
      select t.project_id, t.estimated_effort, h.cost_usd, h.duration_ms
      from handoffs h
      join tasks t on t.id = h.task_id
      where h.cost_usd is not null
    `,
  ]);

  const toRunnable = (row: typeof tasks.$inferSelect): RunnableTask => ({
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    executorMode: row.executorMode,
    taskType: row.taskType,
    autonomyLevel: row.autonomyLevel,
    estimatedEffort: row.estimatedEffort,
    createdAt: toIso(row.createdAt),
  });

  const humanHeldIds = new Set(executingActors.filter((r) => r.actor_type === "human").map((r) => r.id));
  const executingRows = await db.select().from(tasks).where(eq(tasks.status, "executing"));

  // which seat each running task is held by, so a per-license
  // concurrency limit can be counted against the right one. `tasks` has no
  // actor column, so it goes the same way governor.ts's getExecutingSnapshot
  // resolves it: latest claim event -> agent name -> that agent's license.
  const agentRows = await db.select({ name: agents.name, licenseId: agents.licenseId }).from(agents);
  const licenseByAgentName = new Map(agentRows.map((a) => [a.name, a.licenseId]));
  const executingLicenseIds = new Map<number, number | null>(
    executingActors.map((r) => [r.id, r.actor_name ? (licenseByAgentName.get(r.actor_name) ?? null) : null]),
  );

  return {
    settings,
    licenseSettings,
    license,
    period,
    periodStart,
    periodEnd,
    spentUsd,
    events,
    reportedResetAt,
    blocked,
    humanHeldIds,
    executingLicenseIds,
    queued: queuedRows.map(toRunnable),
    executing: executingRows.map(toRunnable),
    history: historyRows.map((h) => ({
      projectId: h.project_id,
      estimatedEffort: h.estimated_effort,
      costUsd: Number(h.cost_usd),
      durationMs: h.duration_ms,
    })),
  };
}

export async function getPlan(licenseId: number, now = new Date(), override = false): Promise<PlanResult> {
  const inputs = await loadPlannerInputs(licenseId, now);
  // Read after loadPlannerInputs, so a rollover it just did is the anchor.
  const latestPeriodEnd = await latestBudgetPeriodEnd(licenseId);
  const { settings, licenseSettings, license, period, periodEnd, spentUsd, events, reportedResetAt, blocked, humanHeldIds, executingLicenseIds, queued, executing, history } = inputs;
  // Agent-held runs only - see loadPlannerInputs on why a human-held task is
  // kept out of the concurrency count but still blocks its repo.
  const agentExecuting = executing.filter((t) => !humanHeldIds.has(t.id));
  // this seat's own limit, and what it is already using of it. The
  // forecast below plans against whichever of the two caps is tighter, since
  // this plan only ever describes what *this* seat can do.
  const seatConcurrency = licenseSettings.concurrencyLimit;
  const seatRunning = agentExecuting.filter((t) => executingLicenseIds.get(t.id) === licenseId).length;
  const planningConcurrency = Math.min(settings.concurrencyGlobal, seatConcurrency);

  const budgetUsd = period?.budgetUsd ?? 0;
  const remainingUsd = Math.max(0, budgetUsd - spentUsd);
  // This license's own effective settings for the fields it can override -
  // see licenses.ts's getLicenseSettings. `concurrencyGlobal` keeps its
  // literal meaning here (the cross-seat cap); the seat's own limit is
  // reported separately as `concurrency.seat` rather than shadowing it, so a
  // reader can't mistake one for the other. defaultTaskCostUsd stays global -
  // it feeds the cost model, which is not a per-seat thing.
  const effectiveSettings: PlannerSettings = { ...settings, sessionBudgetUsd: licenseSettings.sessionBudgetUsd };

  const model: CostModel = buildCostModel(history, {
    defaultTaskCostUsd: settings.defaultTaskCostUsd,
    useEffortScaling: settings.useEffortScaling,
  });
  const estimate = (task: RunnableTask) => estimateTaskCost(task, model);

  const windows = deriveSessionWindows(events);
  const sessionState: SessionWindowState = sessionWindowState(windows, effectiveSettings.sessionBudgetUsd, now, reportedResetAt);

  const ranked = rankRunnableTasks(queued, blocked);
  // Agent-eligible but for the dependency gate - i.e. what would be runnable
  // the moment whatever it waits on finishes.
  const blockedCount = rankRunnableTasks(queued, new Set()).length - ranked.length;
  const queueCostUsd = ranked.reduce((sum, t) => sum + estimate(t).costUsd, 0);

  const horizonEnd = period ? periodEnd : new Date(now.getTime() + SESSION_WINDOW_MS);
  const slots = planSlots(sessionState, now, horizonEnd);
  const pace = computePace(remainingUsd, queueCostUsd, slots.length, effectiveSettings.sessionBudgetUsd);

  // the timeline forecasts *this seat's* work, so only this seat's
  // running tasks occupy its slots - counting another seat's runs against a
  // cap this seat can't spend anyway understated its free capacity. The other
  // seats' runs still bind through startableNow's global check below, which is
  // the gate that actually decides, and through the repo-conflict rule.
  const runningPlanned: PlannedTask[] = agentExecuting
    .filter((t) => executingLicenseIds.get(t.id) === licenseId)
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      projectId: t.projectId,
      priority: t.priority,
      estimatedCostUsd: estimate(t).costUsd,
      estimateBasis: estimate(t).basis,
      running: true,
    }));

  const packed = packPlan({
    slots,
    ranked,
    running: runningPlanned,
    estimate,
    pace,
    sessionCapUsd: effectiveSettings.sessionBudgetUsd,
    remainingBudgetUsd: remainingUsd,
    concurrency: planningConcurrency,
    meanDurationMs: model.meanDurationMs,
  });

  const plannedTotal = packed.slots.reduce((sum, s) => sum + s.plannedUsd, 0);
  const load: PlanLoad = {
    queueCostUsd,
    remainingBudgetUsd: remainingUsd,
    coverage: remainingUsd > 0 ? queueCostUsd / remainingUsd : 0,
    verdict: period ? loadVerdict(queueCostUsd, remainingUsd) : "unknown",
    unspendableUsd: Math.max(0, remainingUsd - plannedTotal),
    idleSlots: packed.slots.filter((s) => s.tasks.length === 0).length,
    runnableTaskCount: ranked.length,
    deferredTaskCount: packed.deferred.length,
    blockedTaskCount: blockedCount,
  };

  const startable = startableNow({
    ranked,
    running: agentExecuting.map((t) => ({ taskId: t.id })),
    estimate,
    sessionRemainingUsd: sessionState.remainingUsd,
    sessionResetsAt: sessionState.resetsAt,
    sessionLimitReported: reportedResetAt !== null,
    periodRemainingUsd: remainingUsd,
    periodConfigured: period !== null,
    concurrency: settings.concurrencyGlobal,
    seatConcurrency,
    seatRunning,
    override,
  });

  return {
    generatedAt: now.toISOString(),
    period: {
      configured: period !== null,
      id: period?.id ?? null,
      startsAt: period?.startsAt ?? null,
      endsAt: period?.endsAt ?? null,
      budgetUsd,
      spentUsd,
      remainingUsd,
      hoursRemaining: period ? Math.max(0, (periodEnd.getTime() - now.getTime()) / 3_600_000) : 0,
      recurrence: describeRecurrence(
        { enabled: license?.recurrenceEnabled ?? false, budgetUsd: license?.recurrenceBudgetUsd ?? null },
        latestPeriodEnd,
      ),
    },
    sessionWindow: {
      openStartsAt: sessionState.open ? sessionState.open.startsAt.toISOString() : null,
      endsAt: sessionState.resetsAt ? sessionState.resetsAt.toISOString() : null,
      capUsd: sessionState.capUsd,
      spentUsd: sessionState.open?.spentUsd ?? 0,
      remainingUsd: sessionState.remainingUsd,
      exhausted: sessionState.exhausted,
    },
    pace,
    binding: packed.binding,
    slots: packed.slots,
    load,
    costModel: {
      globalMeanUsd: model.globalMeanUsd,
      usdPerEffortPoint: model.usdPerEffortPoint,
      effortLine: model.effortLine,
      effortMeans: [...model.effortBucketMeanUsd].sort(([a], [b]) => a - b).map(([effort, meanUsd]) => ({ effort, meanUsd })),
      meanDurationMs: model.meanDurationMs,
      sampleCount: model.sampleCount,
      useEffortScaling: model.useEffortScaling,
    },
    settings: effectiveSettings,
    concurrency: { global: settings.concurrencyGlobal, seat: seatConcurrency, seatRunning },
    startable,
  };
}

// The dispatcher-facing slice: just "what may I start right now", without the
// forecast. Kept as its own function so foreman's poll stays cheap - it runs
// every 60s and has no use for the slot breakdown.
export async function getPlanNext(licenseId: number, now = new Date(), override = false): Promise<
  StartableResult & {
    periodConfigured: boolean;
    periodRemainingUsd: number;
    sessionRemainingUsd: number;
    // `concurrency` is this seat's own limit; `concurrencyGlobal`
    // the cross-seat cap. foreman needs both - it counts its own in-flight
    // runs per seat and in total, and either cap can be the binding one.
    concurrency: number;
    concurrencyGlobal: number;
    seatRunning: number;
  }
> {
  const plan = await getPlan(licenseId, now, override);
  return {
    ...plan.startable,
    periodConfigured: plan.period.configured,
    periodRemainingUsd: plan.period.remainingUsd,
    sessionRemainingUsd: plan.sessionWindow.remainingUsd,
    concurrency: plan.concurrency.seat,
    concurrencyGlobal: plan.concurrency.global,
    seatRunning: plan.concurrency.seatRunning,
  };
}

// "may *this specific* task start right now?" - the gate foreman's
// `work task run <id>` path needs, as opposed to `/plan/next`'s "pick me
// something". Same rules, same code: the task becomes the sole candidate and
// startableNow decides, so the direct path and the dispatcher can't drift into
// disagreeing about what's allowed.
//
// A task already in `executing` (a resumed attempt) is evaluated as itself
// rather than being counted as its own competitor - otherwise a retry would
// always trip the conflict rule against its own repo.
export interface PlanGateResult {
  ok: boolean;
  reason: string | null;
  waitUntil: string | null;
  // the `--max-budget-usd` this run may spend, derived from the
  // task's own cost estimate and effort (see cost-model.ts's runBudgetForTask).
  // foreman used to hardcode $2 for every task regardless of size, which
  // meant a task genuinely needing more could never finish no matter how
  // many attempts it was given - each attempt got a fresh $2 and died at the
  // same wall. Returned on every gate response, including a refusal, so the
  // caller never has to guess at a fallback.
  budgetUsd: number;
}

export async function getPlanGate(taskId: number, licenseId: number, now = new Date(), override = false): Promise<PlanGateResult> {
  const inputs = await loadPlannerInputs(licenseId, now);
  const { settings, licenseSettings, period, spentUsd, events, reportedResetAt, blocked, humanHeldIds, executingLicenseIds, queued, executing, history } = inputs;

  const model = buildCostModel(history, { defaultTaskCostUsd: settings.defaultTaskCostUsd, useEffortScaling: settings.useEffortScaling });

  const candidate = [...queued, ...executing].find((t) => t.id === taskId);
  if (!candidate) {
    return {
      ok: false,
      reason: `task ${taskId} is not queued or executing`,
      waitUntil: null,
      budgetUsd: RUN_BUDGET_FLOOR_USD,
    };
  }

  // computed before any refusal branch so every response carries
  // it. A caller that ignores `ok` and reads only `budgetUsd` still gets a
  // sane number rather than undefined.
  const budgetUsd = runBudgetForTask(estimateTaskCost(candidate, model).costUsd, candidate.estimatedEffort);

  // An override relaxes the dependency gate here, but only here. Before #140
  // the direct `work task run <id>` path never checked dependencies at all, so
  // an operator could always force-run a task whose blocker didn't really
  // matter; routing that path through the plan would have quietly removed that
  // escape hatch. `/plan/next` deliberately does not get the same treatment -
  // it feeds an unattended loop with no human judgement behind it, and a
  // dispatcher that ignores dependencies is just a dispatcher that runs work
  // out of order.
  const eligible = rankRunnableTasks([candidate], override ? new Set<number>() : blocked);
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: blocked.has(taskId)
        ? `task ${taskId} is waiting on an unfinished dependency`
        : `task ${taskId} is not agent-runnable (executorMode/autonomyLevel)`,
      waitUntil: null,
      budgetUsd,
    };
  }

  const sessionState = sessionWindowState(deriveSessionWindows(events), licenseSettings.sessionBudgetUsd, now, reportedResetAt);
  const others = executing.filter((t) => t.id !== taskId);
  // the same two caps the dispatcher path applies - a task this
  // gate lets through must not then be refused by the claim-time per-license
  // check in governor.ts.
  const seatRunning = others.filter((t) => !humanHeldIds.has(t.id) && executingLicenseIds.get(t.id) === licenseId).length;

  const result = startableNow({
    ranked: eligible,
    running: others.filter((t) => !humanHeldIds.has(t.id)).map((t) => ({ taskId: t.id })),
    estimate: (task: RunnableTask) => estimateTaskCost(task, model),
    sessionRemainingUsd: sessionState.remainingUsd,
    sessionResetsAt: sessionState.resetsAt,
    sessionLimitReported: reportedResetAt !== null,
    periodRemainingUsd: period ? Math.max(0, period.budgetUsd - spentUsd) : 0,
    periodConfigured: period !== null,
    concurrency: settings.concurrencyGlobal,
    seatConcurrency: licenseSettings.concurrencyLimit,
    seatRunning,
    override,
  });

  return {
    ok: result.tasks.some((t) => t.taskId === taskId),
    reason: result.tasks.length ? null : result.reason,
    waitUntil: result.waitUntil,
    budgetUsd,
  };
}

