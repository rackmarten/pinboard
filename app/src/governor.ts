import { and, desc, eq, lte } from "drizzle-orm";
import { config } from "./config.js";
import { db, sql } from "./db/client.js";
import { agents, budgetRateHistory, budgetRates, tasks, usageObservations } from "./db/schema.js";
import { getLicenseSettings } from "./licenses.js";
import { getPlannerSettings } from "./settings.js";
import { calibrationCostUsd, currentWeeklyResetStart } from "./usage.js";

export type Scope = "week" | "session";
export type GovernorState = "unconfigured" | "healthy" | "over_rate" | "danger" | "critical";
export type ObservationSource = "manual" | "derived";

export interface Observation {
  id: number;
  scope: Scope;
  percentRemaining: number;
  note: string | null;
  source: ObservationSource;
  observedAt: string;
  createdAt: string;
}

export function validateScope(value: unknown): Scope {
  if (value !== "week" && value !== "session") throw new Error("scope must be 'week' or 'session'");
  return value;
}

export function validatePercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error("percentRemaining must be an integer 0-100");
  return n;
}

export async function recordObservation(
  scope: Scope,
  percentRemaining: number,
  note?: string,
  source: ObservationSource = "manual",
): Promise<Observation> {
  const [row] = await db.insert(usageObservations).values({ scope, percentRemaining, note, source }).returning();
  return row as unknown as Observation;
}

export async function listObservations(scope?: Scope, limit = 20, source?: ObservationSource): Promise<Observation[]> {
  const conditions = [scope ? eq(usageObservations.scope, scope) : undefined, source ? eq(usageObservations.source, source) : undefined].filter(
    (c): c is Exclude<typeof c, undefined> => c !== undefined,
  );
  const rows = await db
    .select()
    .from(usageObservations)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(usageObservations.observedAt))
    .limit(limit);
  return rows as unknown as Observation[];
}

// I16: operator-entered $-to-% rate, so a real costUsd can be turned into an
// estimated %-of-window without waiting for the operator's next manual
// allowance reading. Kept as its own effective-dated table (not a mutable
// settings row) since Anthropic can move this ratio at any time (a promo, a
// plan change) and a past rate should stay recoverable for historical
// figures instead of being overwritten.
export interface BudgetRate {
  id: number;
  usdPerSessionPercent: number;
  usdPerWeekPercent: number;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
}

export function validateRate(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be a positive number`);
  return n;
}

export async function recordBudgetRate(
  usdPerSessionPercent: number,
  usdPerWeekPercent: number,
  effectiveFrom?: Date,
  note?: string,
): Promise<BudgetRate> {
  const [row] = await db
    .insert(budgetRates)
    .values({
      usdPerSessionPercent: String(usdPerSessionPercent),
      usdPerWeekPercent: String(usdPerWeekPercent),
      effectiveFrom,
      note,
    })
    .returning();
  // log every rate change to its own history table so drift over
  // time can be charted without reasoning about budgetRates' effective-dating.
  await db.insert(budgetRateHistory).values({
    usdPerSessionPercent: String(usdPerSessionPercent),
    usdPerWeekPercent: String(usdPerWeekPercent),
    recordedAt: effectiveFrom,
  });
  return rowToBudgetRate(row);
}

export async function listBudgetRates(limit = 20): Promise<BudgetRate[]> {
  const rows = await db.select().from(budgetRates).orderBy(desc(budgetRates.effectiveFrom)).limit(limit);
  return rows.map(rowToBudgetRate);
}

export interface BudgetRateHistoryEntry {
  id: number;
  usdPerSessionPercent: number;
  usdPerWeekPercent: number;
  recordedAt: string;
}

export async function listBudgetRateHistory(limit = 50): Promise<BudgetRateHistoryEntry[]> {
  const rows = await db.select().from(budgetRateHistory).orderBy(desc(budgetRateHistory.recordedAt)).limit(limit);
  return rows.map((row) => ({
    id: row.id,
    usdPerSessionPercent: Number(row.usdPerSessionPercent),
    usdPerWeekPercent: Number(row.usdPerWeekPercent),
    recordedAt: (row.recordedAt as unknown as Date).toISOString?.() ?? String(row.recordedAt),
  }));
}

// Latest rate whose effectiveFrom is at or before `at` - a rate entered
// today shouldn't retroactively apply to a cost incurred before it was
// recorded, so this is a plain lookup, not "the most recently inserted row".
export async function getRateAt(at: Date): Promise<BudgetRate | null> {
  const [row] = await db
    .select()
    .from(budgetRates)
    .where(lte(budgetRates.effectiveFrom, at))
    .orderBy(desc(budgetRates.effectiveFrom))
    .limit(1);
  return row ? rowToBudgetRate(row) : null;
}

function rowToBudgetRate(row: typeof budgetRates.$inferSelect): BudgetRate {
  return {
    id: row.id,
    usdPerSessionPercent: Number(row.usdPerSessionPercent),
    usdPerWeekPercent: Number(row.usdPerWeekPercent),
    effectiveFrom: (row.effectiveFrom as unknown as Date).toISOString?.() ?? String(row.effectiveFrom),
    note: row.note,
    createdAt: (row.createdAt as unknown as Date).toISOString?.() ?? String(row.createdAt),
  };
}

// Pure so it's cheaply unit-testable without a DB - the estimate is always
// labeled as such in the UI, never used for gating (see PLAN.md's I16 scope
// note).
export function estimatePercent(costUsd: number, usdPerPercent: number | null): number | null {
  if (usdPerPercent === null || usdPerPercent <= 0) return null;
  return costUsd / usdPerPercent;
}

// Agent spend plus interactive-session spend - see usage.ts's
// calibrationCostUsd for which sources count here.
async function sumCostBetween(start: Date, end: Date): Promise<number> {
  const [[row], eventRows] = await Promise.all([
    sql<{ total: string | null }[]>`
      select coalesce(sum(cost_usd::numeric), 0) as total
      from handoffs
      where created_at >= ${start.toISOString()} and created_at <= ${end.toISOString()}
    `,
    sql<{ source: string; total: string }[]>`
      select source, coalesce(sum(cost_usd::numeric), 0) as total
      from usage_events
      where occurred_at >= ${start.toISOString()} and occurred_at <= ${end.toISOString()}
      group by source
    `,
  ]);
  return calibrationCostUsd(Number(row?.total ?? 0), Object.fromEntries(eventRows.map((r) => [r.source, Number(r.total)])));
}

async function sumCostSince(start: Date): Promise<number> {
  return sumCostBetween(start, new Date());
}

// Pure state-ranking so the "worst of week/session" combination and unit
// tests don't need a DB. unconfigured ranks alongside healthy - no
// observation yet is not a reason to throttle, it's a reason to nag the
// operator to record one (surfaced separately in the UI).
const STATE_RANK: Record<GovernorState, number> = {
  unconfigured: 0,
  healthy: 0,
  over_rate: 1,
  danger: 2,
  critical: 3,
};

export function worstState(a: GovernorState, b: GovernorState): GovernorState {
  // unconfigured only wins when *both* scopes lack data - each scope card
  // already says "no observation recorded yet" on its own, so the overall
  // banner shouldn't get stuck nagging about one missing scope forever once
  // the other has real, worse-than-healthy data to show instead.
  if (a === "unconfigured") return b;
  if (b === "unconfigured") return a;
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

export function deriveState(availablePercent: number | null): GovernorState {
  if (availablePercent === null) return "unconfigured";
  if (availablePercent <= config.governor.criticalThresholdPercent) return "critical";
  if (availablePercent <= config.governor.dangerThresholdPercent) return "danger";
  if (availablePercent <= config.governor.overRateThresholdPercent) return "over_rate";
  return "healthy";
}

// Next weekly reset at the configured day-of-week/hour, server-local time -
// see config.ts's note on where that Friday 16:00 default came from.
export function nextWeeklyReset(now = new Date()): Date {
  const next = new Date(now);
  next.setHours(config.governor.resetHour, 0, 0, 0);
  let daysAhead = (config.governor.resetDayOfWeek - next.getDay() + 7) % 7;
  if (daysAhead === 0 && next.getTime() <= now.getTime()) daysAhead = 7;
  next.setDate(next.getDate() + daysAhead);
  return next;
}

interface ScopeStatus {
  scope: Scope;
  latestObservation: Observation | null;
  ageMs: number | null;
  availablePercent: number | null;
  state: GovernorState;
  costSinceObservationUsd: number | null;
  impliedDollarsPerPercent: number | null;
  // I16: costSinceObservationUsd converted to an estimated %-of-window via
  // the operator's own recorded budget_rates, as a stand-in for
  // impliedDollarsPerPercent when there aren't yet two observations to
  // derive it from (or as a cross-check when there are). Null whenever no
  // rate has been recorded yet - always presented as an estimate, never
  // used for gating.
  estimatedPercentUsedSinceObservation: number | null;
}

// the only cycle boundary this codebase actually tracks is the
// weekly plan-allowance reset (config.governor.resetDayOfWeek/resetHour,
// mirroring nextWeeklyReset above rather than the operator-configurable
// settings.ts version, to stay consistent with the rest of this file). The
// rolling 5h session window has no equivalent tracked boundary, so a manual
// session reading never auto-expires - it's superseded the moment a new
// manual reading comes in, same as before this task.
export function cycleStartFor(scope: Scope, now = new Date()): Date | null {
  if (scope !== "week") return null;
  return currentWeeklyResetStart(now, config.governor.resetDayOfWeek, config.governor.resetHour);
}

async function isManualObservationCurrent(scope: Scope): Promise<{ manual: Observation | null; current: boolean }> {
  const [manual] = await listObservations(scope, 1, "manual");
  if (!manual) return { manual: null, current: false };
  const cycleStart = cycleStartFor(scope);
  const current = !cycleStart || new Date(manual.observedAt) >= cycleStart;
  return { manual, current };
}

// The observation the governor should actually treat as "current allowance"
// for this scope: a manual reading stays authoritative until its cycle ends
// (see cycleStartFor), after which the latest auto-derived one takes over -
// falling back to a stale manual reading if nothing has been derived yet.
async function effectiveObservation(scope: Scope): Promise<Observation | null> {
  const { manual, current } = await isManualObservationCurrent(scope);
  if (manual && current) return manual;
  const [derived] = await listObservations(scope, 1, "derived");
  return derived ?? manual;
}

// Called after each new usage entry (a handoff's real costUsd) so the
// governor % keeps tracking real spend between manual allowance checks
// instead of going stale the moment the operator stops punching in numbers.
// Recomputed fresh from the manual baseline each time (never chained off a
// previously derived value) so rounding and rate changes don't compound.
export async function deriveObservationFromUsage(scope: Scope): Promise<Observation | null> {
  const rate = await getRateAt(new Date());
  const usdPerPercent = rate ? (scope === "week" ? rate.usdPerWeekPercent : rate.usdPerSessionPercent) : null;
  if (usdPerPercent === null) return null; // no budget rate recorded yet - nothing to convert cost into %

  const { manual, current } = await isManualObservationCurrent(scope);
  const cycleStart = cycleStartFor(scope);

  let baselinePercent: number;
  let baselineAt: Date;
  if (manual && current) {
    baselinePercent = manual.percentRemaining;
    baselineAt = new Date(manual.observedAt);
  } else if (cycleStart) {
    // The manual reading (if any) predates the current cycle - the plan's
    // own allowance window has reset since then, so assume a fresh 100% as
    // of the reset boundary rather than carrying the stale number forward.
    baselinePercent = 100;
    baselineAt = cycleStart;
  } else {
    return null; // no cycle boundary to assume a fresh 100% from, and no manual reading to baseline off (session scope, never observed)
  }

  const costSinceBaseline = await sumCostSince(baselineAt);
  const percentUsed = estimatePercent(costSinceBaseline, usdPerPercent) ?? 0;
  const percentRemaining = Math.max(0, Math.min(100, Math.round(baselinePercent - percentUsed)));
  return recordObservation(scope, percentRemaining, undefined, "derived");
}

async function scopeStatus(scope: Scope): Promise<ScopeStatus> {
  const latest = await effectiveObservation(scope);
  // impliedDollarsPerPercent is a real-world cross-check, so it's derived
  // from two actual manual readings only - mixing in "derived" entries here
  // would be circular, since those are themselves computed from the rate.
  const [latestManual, priorManual] = await listObservations(scope, 2, "manual");
  const impliedBasis = latestManual ?? null;
  const prior = priorManual ?? null;

  const availablePercent = latest ? Math.max(0, latest.percentRemaining - config.governor.reserveFloorPercent) : null;
  const costSinceObservationUsd = latest ? await sumCostSince(new Date(latest.observedAt)) : null;
  const currentRate = await getRateAt(new Date());
  const usdPerPercent = currentRate ? (scope === "week" ? currentRate.usdPerWeekPercent : currentRate.usdPerSessionPercent) : null;
  const estimatedPercentUsedSinceObservation =
    costSinceObservationUsd !== null ? estimatePercent(costSinceObservationUsd, usdPerPercent) : null;

  // Informational only, not used for gating - see the schema.ts note on why
  // interpolation isn't load-bearing. Only computable when the percent
  // actually dropped between the two most recent same-scope manual entries
  // (a rise means the window reset in between, which makes the ratio
  // meaningless).
  let impliedDollarsPerPercent: number | null = null;
  if (impliedBasis && prior && prior.percentRemaining > impliedBasis.percentRemaining) {
    const cost = await sumCostBetween(new Date(prior.observedAt), new Date(impliedBasis.observedAt));
    const percentDrop = prior.percentRemaining - impliedBasis.percentRemaining;
    impliedDollarsPerPercent = percentDrop > 0 ? cost / percentDrop : null;
  }

  return {
    scope,
    latestObservation: latest,
    ageMs: latest ? Date.now() - new Date(latest.observedAt).getTime() : null,
    availablePercent,
    state: deriveState(availablePercent),
    costSinceObservationUsd,
    impliedDollarsPerPercent,
    estimatedPercentUsedSinceObservation,
  };
}

export interface ExecutingTask {
  taskId: number;
  projectId: number;
  actorName: string | null;
  provider: string | null;
  // which license the executing actor's agent belongs to, null
  // when the actor isn't a registered agent (e.g. a human claim) or has none
  // resolvable - see checkConcurrencyForClaim's perLicense check below.
  licenseId: number | null;
}

// Tasks currently claimed by a live (unexpired) lease, joined against each
// one's most recent claim event to recover who's actually running it -
// tasks carries no "current agent" column of its own, see routes.ts's claim
// handler. Shared by the /governor/status readout and the claim-time
// concurrency check so both count the exact same thing.
export async function getExecutingSnapshot(): Promise<ExecutingTask[]> {
  // a task whose own session is parked waiting on a human reply
  // (an open task-scoped chat thread with awaitingAgent false - see
  // schema.ts's chatThreads comment and runner.ts's isAwaitingHumanReply)
  // isn't actually consuming a concurrency slot - the `claude -p` process is
  // just polling `work task ask` in a sleep loop. Counting it against the
  // concurrency limits anyway was what made one task's blocking question
  // stall the whole dispatch queue: with the default global/perProject/
  // perAgent limits all at 1, no other queued task could ever be claimed
  // until the blocked one either got answered or timed out. Excluding it
  // here lets foreman's dispatcher claim and run a different task while this
  // one waits, without loosening the concurrency limits themselves.
  //
  // the same stall recurred for a different reason - an
  // executorMode: "human" umbrella task (e.g. #146) left in `executing` for
  // days while its agent-run children shipped. Such a task has no live
  // lease at all (leaseExpiresAt is only ever set by the claim route's
  // agent-claim path), yet the old `lease_expires_at is null or ... > now()`
  // check treated "never leased" the same as "leased and still current" and
  // counted it anyway. A lease is the thing that actually says "a session
  // holds this", so a row only counts now when that lease is live - null or
  // expired no longer counts, which also self-heals an agent task whose
  // lease expired without a handoff. The `executor_mode != 'human'` check
  // stays alongside it as belt and braces (matching plan.ts's separate
  // human-hold exclusion) for the case where a lease is somehow live on a
  // task no agent is actually running.
  const rows = await sql<{ task_id: number; project_id: number; actor_name: string | null }[]>`
    select t.id as task_id, t.project_id, ev.actor_name
    from tasks t
    left join lateral (
      select actor_name from task_events
      where task_id = t.id and event_type = 'claim'
      order by created_at desc limit 1
    ) ev on true
    where t.status = 'executing'
      and t.executor_mode != 'human'
      and t.lease_expires_at is not null and t.lease_expires_at > now()
      and not exists (
        select 1 from chat_threads ct
        where ct.task_id = t.id and ct.status = 'open' and ct.awaiting_agent = false
      )
  `;
  const agentRows = await db.select({ name: agents.name, provider: agents.provider, licenseId: agents.licenseId }).from(agents);
  const agentByName = new Map(agentRows.map((a) => [a.name, a]));
  return rows.map((r) => ({
    taskId: r.task_id,
    projectId: r.project_id,
    actorName: r.actor_name,
    provider: r.actor_name ? (agentByName.get(r.actor_name)?.provider ?? null) : null,
    licenseId: r.actor_name ? (agentByName.get(r.actor_name)?.licenseId ?? null) : null,
  }));
}

// Concurrency is meant as a structural cap, not a judgment call - only agent
// claims are limited (a human claiming a task by hand isn't "an autonomous
// agent spawning many expensive agents", the thing this is guarding
// against). Called from the claim route itself, before the update, so it
// isn't just advisory the way a foreman-side-only check would be - but it
// is not atomic with that update (no row lock/transaction spans the two),
// same shape as the pre-existing lease-conflict check just above it in the
// route handler. Two claims racing in the same instant could both pass this
// check and both succeed, exceeding a limit by one. Acceptable today: only
// one thing ever calls `work task run` at a time (there is no concurrent
// dispatcher yet - see PLAN.md's I7). Revisit with a real transaction/lock
// once something actually dispatches multiple claims concurrently.
export async function checkConcurrencyForClaim(
  taskId: number,
  actorType: string,
  actorName: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (actorType !== "agent") return { ok: true };

  const [task] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId));
  if (!task) return { ok: true }; // route's own 404 check handles this

  const executing = (await getExecutingSnapshot()).filter((t) => t.taskId !== taskId);
  const [agent] = await db
    .select({ provider: agents.provider, licenseId: agents.licenseId })
    .from(agents)
    .where(eq(agents.name, actorName));
  const provider = agent?.provider ?? null;

  // the global cap is operator-editable from the Plan screen now
  // (app_settings), so it comes from settings rather than env alone; the
  // narrower per-agent/per-project/per-provider caps are unchanged.
  const planner = await getPlannerSettings();
  const limits = { ...config.governor.concurrency, global: planner.concurrencyGlobal };
  const checks: [number, number, string][] = [
    [executing.length, limits.global, `global concurrency limit (${limits.global}) reached`],
    [
      executing.filter((t) => t.projectId === task.projectId).length,
      limits.perProject,
      `per-project concurrency limit (${limits.perProject}) reached for this project`,
    ],
    [
      executing.filter((t) => t.actorName === actorName).length,
      limits.perAgent,
      `per-agent concurrency limit (${limits.perAgent}) reached for agent '${actorName}'`,
    ],
  ];
  if (provider) {
    checks.push([
      executing.filter((t) => t.provider === provider).length,
      limits.perProvider,
      `per-provider concurrency limit (${limits.perProvider}) reached for provider '${provider}'`,
    ]);
  }
  // a license's own concurrency slot count (its override, else the
  // same appSettings/config default the global limit above falls back to) -
  // additive to, not a replacement for, the global/per-project/per-agent/
  // per-provider checks. Skipped when the claiming actor isn't a registered
  // agent with a license (getExecutingSnapshot already returns null for that
  // case, same as provider above).
  if (agent?.licenseId != null) {
    const licenseSettings = await getLicenseSettings(agent.licenseId);
    checks.push([
      executing.filter((t) => t.licenseId === agent.licenseId).length,
      licenseSettings.concurrencyLimit,
      `per-license concurrency limit (${licenseSettings.concurrencyLimit}) reached for license id ${agent.licenseId}`,
    ]);
  }

  for (const [count, limit, reason] of checks) {
    if (count >= limit) return { ok: false, reason };
  }

  // A past task's repo-set conflict rule used to be enforced here as well: two
  // tasks whose effective repo sets overlapped could not run at once, because
  // foreman put every run in a git worktree inside the one workspace checkout
  // of that repo. A past task gave each run its own clone of every repo it may
  // write to, so that is no longer true and the rule was removed - with most
  // projects auto-deploy, narrowing it instead would have left almost
  // everything serialised for no remaining reason. Deploying is the one step
  // that still must not overlap, and foreman serialises that with its own
  // per-repo deploy lock (see foreman's app/src/workdir.ts).

  return { ok: true };
}

export interface GovernorStatus {
  week: ScopeStatus;
  session: ScopeStatus;
  state: GovernorState;
  reserveFloorPercent: number;
  thresholds: { overRatePercent: number; dangerPercent: number; criticalPercent: number; priorityGate: number };
  nextWeeklyResetAt: string;
  hoursUntilWeeklyReset: number;
  concurrency: { limits: typeof config.governor.concurrency; executing: ExecutingTask[] };
}

export async function getGovernorStatus(): Promise<GovernorStatus> {
  const [week, session, executing, planner] = await Promise.all([
    scopeStatus("week"),
    scopeStatus("session"),
    getExecutingSnapshot(),
    // report the same global limit the claim check actually
    // enforces, which is now operator-editable, rather than the env default
    // this used to echo back.
    getPlannerSettings(),
  ]);
  const reset = nextWeeklyReset();

  return {
    week,
    session,
    state: worstState(week.state, session.state),
    reserveFloorPercent: config.governor.reserveFloorPercent,
    thresholds: {
      overRatePercent: config.governor.overRateThresholdPercent,
      dangerPercent: config.governor.dangerThresholdPercent,
      criticalPercent: config.governor.criticalThresholdPercent,
      priorityGate: config.governor.priorityGate,
    },
    nextWeeklyResetAt: reset.toISOString(),
    hoursUntilWeeklyReset: (reset.getTime() - Date.now()) / 3_600_000,
    concurrency: { limits: { ...config.governor.concurrency, global: planner.concurrencyGlobal }, executing },
  };
}
