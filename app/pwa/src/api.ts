import type { ChatEvent } from "./chat-transcript.js";

export type { ChatEvent } from "./chat-transcript.js";

// Kept in sync by hand with app/src/db/schema.ts's comments and
// idea-task-management.md's "Task Lifecycle"/"Task Types" - not every
// status needs a stage. Label assignment isn't exposed in the UI yet
// (I1b scope is list/filter/detail/comment/create/edit). "rejected" is a
// terminal status a human sets by hand on an accidental duplicate or
// otherwise unwanted task - TaskListView excludes it from the default
// (no status filter) view so it doesn't clutter the list, but it's still
// selectable in the Status filter to find rejected tasks again.
// Server-side copy (validated on POST/PATCH): app/src/task-model.ts.
export const TASK_STATUSES = [
  "idea",
  "defined",
  "planned",
  "decomposed",
  "queued",
  "executing",
  "needs_input",
  "handoff",
  // the post-PR pipeline, between the agent opening a PR and a
  // human looking at the result - see app/src/pipeline.ts for what each one
  // means and which moves between them are legal. Driven by foreman's poller,
  // not by a person, so they show up here only to be rendered and filtered.
  "awaiting_ci",
  "awaiting_merge",
  "awaiting_review",
  "deploying",
  "verifying",
  "review",
  "rework",
  "done",
  "rejected",
] as const;

export const TASK_TYPES = [
  "idea",
  "research",
  "decision",
  "architecture",
  "implementation",
  "bug",
  "testing",
  "review",
  "deployment",
  "maintenance",
  // a parent task grouping ordered increments; never runnable.
  "story",
] as const;

export const EXECUTOR_MODES = ["human", "agent", "human+agent"] as const;

// Story-point-like AI effort scale, not engineering time - see
// app/src/routes.ts's EFFORT_LEVELS.
export const EFFORT_LEVELS = [1, 2, 3, 5, 8, 13] as const;

// See idea-task-management.md's "Autonomy Levels".
export const AUTONOMY_LEVELS = [
  { value: 0, title: "0 - Human only" },
  { value: 1, title: "1 - Assist" },
  { value: 2, title: "2 - Prepare" },
  { value: 3, title: "3 - Execute small tasks" },
  { value: 4, title: "4 - Autonomous" },
  { value: 5, title: "5 - Full autonomy" },
] as const;

// The executors foreman runs, mirrored from the API's AGENT_EXECUTORS (which
// rejects anything else). "cli" first: it is the default for a new agent.
export const AGENT_EXECUTORS = [
  { value: "cli", title: "cli", hint: "Claude Code runner: worktree, commits, PR. A seat's default for queued tasks" },
  { value: "cli-host", title: "cli-host", hint: "Unrestricted chat persona; never picked up by dispatch" },
  { value: "8ball", title: "8ball", hint: "LLM gateway, no repo or PR; only reached through a routing rule" },
] as const;

// a new agent starts on "cli"; an existing one keeps what it has, even a
// value saved before the API started validating it.
export function defaultAgentExecutor(agent?: { executor: string } | null): string {
  return agent?.executor ?? AGENT_EXECUTORS[0].value;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  localPath: string | null;
  repoUrl: string | null;
  parentProjectId: number | null;
  autoDeployAllowed: boolean;
  archived: boolean;
  context: string | null;
  relatedProjectIds: number[];
  createdAt: string;
}

// I10: parent | child | related | depends_on - see app/src/db/schema.ts's
// comment on taskRelations.
export const RELATION_TYPES = ["parent", "child", "related", "depends_on"] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

// Inverse label for rendering the "to" direction of a relation on the other
// task's own detail view - e.g. if A is the parent of B, B's own page should
// read "child of A", not repeat "parent" backwards.
export const RELATION_INVERSE: Record<RelationType, string> = {
  parent: "child",
  child: "parent",
  related: "related",
  depends_on: "is a dependency of",
};

export interface TaskRelation {
  id: number;
  fromTaskId: number;
  toTaskId: number;
  relationType: RelationType;
  direction: "from" | "to";
  // dependencySatisfied: an earlier story's gate rule, see app/src/task-model.ts.
  otherTask: {
    id: number;
    title: string;
    status: string;
    taskType: string;
    executorMode: string;
    priority: number;
    dependencySatisfied: boolean;
  } | null;
  createdAt: string;
}

export interface Label {
  id: number;
  name: string;
  color: string | null;
}

export interface Task {
  id: number;
  projectId: number;
  title: string;
  description: string | null;
  taskType: string;
  // set on GET /tasks rows (from parent/child relations), absent on GET /tasks/:id.
  parentTaskId?: number | null;
  status: string;
  executorMode: string;
  priority: number;
  autonomyLevel: number | null;
  estimatedEffort: number | null;
  actualCostUsd: string | null;
  actualDurationMs: number | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
  controlAction: "stop" | "kill" | null;
  controlRequestedAt: string | null;
  relatedProjectIds: number[];
  // set while the task sits in one of the pipeline statuses above,
  // null otherwise. repairReason/repairContext are set only by a stage handing
  // the task back to `queued` for another agent run.
  pipelineStageEnteredAt: string | null;
  repairReason: string | null;
  repairContext: string | null;
  // CTIDs a `root-access` task wants root on, and the operator's
  // grant for them (written only by POST /tasks/:id/root-grant).
  rootScope: number[];
  rootGrantCtids: number[] | null;
  rootGrantExpiresAt: string | null;
  rootGrantedAt: string | null;
  rootGrantedBy: string | null;
  // open and recently answered asks, on GET /tasks/:id only.
  asks?: TaskAsk[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends Task {
  labels: { id: number; name: string; color: string | null }[];
}

export interface Comment {
  id: number;
  taskId: number;
  authorType: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  id: number;
  taskId: number;
  url: string;
  repoSlug: string;
  branchName: string | null;
  state: "open" | "merged" | "closed";
  attemptNumber: number | null;
  createdAt: string;
  updatedAt: string;
}

// pinboard's JSON API lives under /api; pages own the root paths.
export const API_BASE = "/api";

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  // marks every request as coming from a person at the PWA, so
  // the server's journal can tell an operator's edit from foreman's.
  const headers: Record<string, string> = { "x-pinboard-client": "pwa", ...((options.headers as Record<string, string>) ?? {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  const resp = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    const message = body.error || body.message || `${path} -> ${resp.status}`;
    // the readiness lint (422) lists every failure.
    throw Object.assign(new Error(Array.isArray(body.failures) ? `${message}: ${body.failures.join("; ")}` : message), {
      status: resp.status,
      failures: Array.isArray(body.failures) ? (body.failures as string[]) : undefined,
    });
  }
  if (resp.status === 204) return undefined as T;
  return resp.json();
}

export function getProjects(opts: { includeArchived?: boolean; q?: string } = {}): Promise<Project[]> {
  const params = new URLSearchParams();
  if (opts.includeArchived) params.set("includeArchived", "true");
  if (opts.q) params.set("q", opts.q);
  const qs = params.toString();
  return api(`/projects${qs ? `?${qs}` : ""}`);
}

export function getProject(id: number): Promise<Project> {
  return api(`/projects/${id}`);
}

export interface ProjectInput {
  slug: string;
  name: string;
  description?: string;
  localPath?: string;
  repoUrl?: string;
  parentProjectId?: number | null;
  autoDeployAllowed?: boolean;
  context?: string;
  relatedProjectIds?: number[];
}

export function createProject(input: ProjectInput): Promise<Project> {
  return api("/projects", { method: "POST", body: JSON.stringify(input) });
}

export function updateProject(
  id: number,
  input: Partial<ProjectInput> & { archived?: boolean; autoDeployAllowed?: boolean },
): Promise<Project> {
  return api(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export interface TaskFilter {
  projectId?: number;
  // scope to a set of projects (the Projects screen's multi-select)
  // rather than a single one - ignored when `projectId` is also set, since
  // that's an explicit single-project override.
  projectIds?: number[];
  // multi-select status filter - undefined/empty means "no
  // explicit filter", left to the caller to decide a default (TaskListView
  // excludes rejected/done client-side in that case).
  status?: string[];
  taskType?: string;
  executorMode?: string;
  // top-bar global search - matches task ID (exact) or title
  // (substring, case-insensitive).
  q?: string;
  // children of one task (a story's children on its detail view).
  parentTaskId?: number;
}

export function getTasks(filter: TaskFilter = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filter.projectId) {
    params.set("projectId", String(filter.projectId));
  } else if (filter.projectIds) {
    // Empty array means "no projects selected" - sent through as an empty
    // value so the backend can distinguish it from "no scope at all"
    // (param absent) rather than treating it as unfiltered.
    params.set("projectId", filter.projectIds.join(","));
  }
  if (filter.status && filter.status.length) params.set("status", filter.status.join(","));
  if (filter.taskType) params.set("taskType", filter.taskType);
  if (filter.executorMode) params.set("executorMode", filter.executorMode);
  if (filter.q) params.set("q", filter.q);
  if (filter.parentTaskId) params.set("parentTaskId", String(filter.parentTaskId));
  const qs = params.toString();
  return api(`/tasks${qs ? `?${qs}` : ""}`);
}

export interface TaskInput {
  projectId: number;
  // bypasses the readiness lint on a move to `queued`.
  force?: boolean;
  title: string;
  description?: string;
  taskType?: string;
  status?: string;
  executorMode?: string;
  priority?: number;
  estimatedEffort?: number | null;
  relatedProjectIds?: number[];
  rootScope?: number[];
}

export function createTask(input: TaskInput): Promise<Task> {
  return api("/tasks", { method: "POST", body: JSON.stringify(input) });
}

export function getTask(id: number): Promise<TaskDetail> {
  return api(`/tasks/${id}`);
}

export function updateTask(id: number, input: Partial<TaskInput>): Promise<Task> {
  return api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

// must match app/src/root-grants.ts's ROOT_LABEL.
export const ROOT_LABEL = "root-access";

export interface RootGrant {
  taskId: number;
  active: boolean;
  ctids: number[];
  expiresAt: string | null;
  grantedAt: string | null;
  grantedBy: string | null;
}

// Only accepted from an operator device through https://pinboard.example.com -
// the server refuses it with a message saying so otherwise.
export function grantRootAccess(taskId: number, ttlHours: number): Promise<Task> {
  return api(`/tasks/${taskId}/root-grant`, { method: "POST", body: JSON.stringify({ ttlHours }) });
}

export function revokeRootAccess(taskId: number): Promise<RootGrant> {
  return api(`/tasks/${taskId}/root-grant`, { method: "DELETE" });
}

export function getLabels(): Promise<Label[]> {
  return api("/labels");
}

export function createLabel(name: string, color?: string): Promise<Label> {
  return api("/labels", { method: "POST", body: JSON.stringify({ name, color }) });
}

export function addTaskLabel(taskId: number, labelId: number): Promise<void> {
  return api(`/tasks/${taskId}/labels`, { method: "POST", body: JSON.stringify({ labelId }) });
}

export function removeTaskLabel(taskId: number, labelId: number): Promise<void> {
  return api(`/tasks/${taskId}/labels/${labelId}`, { method: "DELETE" });
}

// I10: task relations - see app/src/routes.ts for the direction/inverse
// semantics this mirrors.
export function getTaskRelations(taskId: number): Promise<TaskRelation[]> {
  return api(`/tasks/${taskId}/relations`);
}

export function addTaskRelation(taskId: number, toTaskId: number, relationType: RelationType): Promise<TaskRelation> {
  return api(`/tasks/${taskId}/relations`, { method: "POST", body: JSON.stringify({ toTaskId, relationType }) });
}

export function deleteTaskRelation(taskId: number, relationId: number): Promise<void> {
  return api(`/tasks/${taskId}/relations/${relationId}`, { method: "DELETE" });
}

// I12a: agent definitions - credentials never live here, see
// idea-task-management.md's "Agent configuration is split deliberately".
// credentialRef is a name foreman resolves against its own secret store.
export interface Agent {
  id: number;
  name: string;
  role: string | null;
  provider: string;
  model: string | null;
  executor: string;
  autonomyLevel: number;
  credentialRef: string | null;
  routingWeight: number;
  enabled: boolean;
  // which license this agent runs under - see License below.
  licenseId: number;
  // grants foreman's chat.ts unrestricted "host" persona
  // (full tool access) to this agent's chat threads instead of the
  // restricted read-only planning persona every other agent gets.
  // Per-agent so each license can flag its own, unlike the old scheme
  // of matching one hardcoded agent name across the whole table.
  isHost: boolean;
  createdAt: string;
}

export interface AgentInput {
  name: string;
  role?: string;
  provider: string;
  model?: string;
  executor: string;
  autonomyLevel?: number;
  credentialRef?: string;
  routingWeight?: number;
  enabled?: boolean;
  licenseId?: number;
  isHost?: boolean;
}

export function getAgents(): Promise<Agent[]> {
  return api("/agents");
}

export function createAgent(input: AgentInput): Promise<Agent> {
  return api("/agents", { method: "POST", body: JSON.stringify(input) });
}

export function updateAgent(id: number, input: Partial<AgentInput>): Promise<Agent> {
  return api(`/agents/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

// an account/license under a provider - see pinboard's
// schema.ts licenses comment for the full rationale. Minimal PWA surface for
// this increment: just enough to list licenses for AgentFormDialog's select -
// no full license-management screen yet.
export interface License {
  id: number;
  name: string;
  provider: string;
  linuxUser: string;
  tokenEnvVar: string | null;
  sessionBudgetUsd: number | null;
  concurrencyLimit: number | null;
  sessionResetAt: string | null;
  // weekly recurring budget periods for this seat.
  recurrenceEnabled: boolean;
  recurrenceBudgetUsd: number | null;
  enabled: boolean;
  createdAt: string;
}

export function getLicenses(): Promise<License[]> {
  return api("/licenses");
}

// Forget this seat's estimated session spend so dispatch can resume. If the
// real window is spent, the next run's session-limit error blocks it again.
export function resetSessionWindow(licenseId: number): Promise<License> {
  return api("/plan/session-reset", { method: "POST", body: JSON.stringify({ licenseId }) });
}

// `sessionBudgetUsd`/`concurrencyLimit` are nullable overrides of
// the appSettings-level defaults - passing null clears the override and puts
// that seat back on the global default.
export function updateLicense(
  id: number,
  patch: {
    sessionBudgetUsd?: number | null;
    concurrencyLimit?: number | null;
    recurrenceEnabled?: boolean;
    recurrenceBudgetUsd?: number | null;
    enabled?: boolean;
  },
): Promise<License> {
  return api(`/licenses/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

// I12a: which agent should run a task when none is explicitly requested -
// consumed by foreman's dispatcher, not enforced here. taskType/labelName
// both null/undefined means "matches anything".
export interface RoutingRule {
  id: number;
  taskType: string | null;
  labelName: string | null;
  agentId: number;
  priority: number;
  enabled: boolean;
  createdAt: string;
}

export interface RoutingRuleInput {
  taskType?: string | null;
  labelName?: string | null;
  agentId: number;
  priority?: number;
  enabled?: boolean;
}

export function getRoutingRules(): Promise<RoutingRule[]> {
  return api("/routing-rules");
}

export function createRoutingRule(input: RoutingRuleInput): Promise<RoutingRule> {
  return api("/routing-rules", { method: "POST", body: JSON.stringify(input) });
}

export function updateRoutingRule(id: number, input: Partial<RoutingRuleInput>): Promise<RoutingRule> {
  return api(`/routing-rules/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteRoutingRule(id: number): Promise<void> {
  return api(`/routing-rules/${id}`, { method: "DELETE" });
}

export function getComments(taskId: number): Promise<Comment[]> {
  return api(`/tasks/${taskId}/comments`);
}

// I19: append-only audit trail, including the runner's live "activity"
// events tailed from a headless session's stream-json output - see
// foreman/app/src/runner.ts's summarizeStreamLine.
export interface TaskEvent {
  id: number;
  taskId: number;
  eventType: string;
  actorType: string;
  actorName: string;
  payload: unknown;
  createdAt: string;
}

export function getEvents(taskId: number): Promise<TaskEvent[]> {
  return api(`/tasks/${taskId}/events`);
}

export function getPullRequests(taskId: number): Promise<PullRequest[]> {
  return api(`/tasks/${taskId}/pull-requests`);
}

export function addComment(taskId: number, body: string, authorName = "marek"): Promise<Comment> {
  return api(`/tasks/${taskId}/comments`, {
    method: "POST",
    body: JSON.stringify({ authorType: "human", authorName, body }),
  });
}

// I4b: review-queue decisions. Approve reuses the same /complete endpoint
// the `work` CLI uses to mark a task done by hand; reject is dedicated
// since there's no other "send back to rework" endpoint. Neither touches
// the PR - pinboard holds no GitHub credentials, so merging stays manual.
// /complete refuses (409) while an open PR row exists; `force`
// is "mark done without merging".
export function approveTask(taskId: number, actorName = "marek", force = false): Promise<Task> {
  return api(`/tasks/${taskId}/complete`, {
    method: "POST",
    body: JSON.stringify({ actorType: "human", actorName, ...(force ? { force } : {}) }),
  });
}

// releasing a task the pipeline is holding for a human - today
// that is only the `awaiting_review` hold before a migration is merged, which
// resumes at `awaiting_merge`. Deliberately the same endpoint foreman's
// poller uses rather than a PATCH of the status, so a human release is
// checked against the same transition table as a machine one.
export function advancePipeline(taskId: number, to: string, actorName = "marek"): Promise<Task> {
  return api(`/tasks/${taskId}/pipeline`, {
    method: "POST",
    body: JSON.stringify({ actorType: "human", actorName, to }),
  });
}

export function rejectTask(taskId: number, actorName = "marek"): Promise<Task> {
  return api(`/tasks/${taskId}/reject`, {
    method: "POST",
    body: JSON.stringify({ actorType: "human", actorName }),
  });
}

// I4c: running-workers screen kill/graceful-stop. foreman's runner polls
// pinboard for this flag itself and clears it once acted on - see
// foreman/app/src/runner.ts.
export function requestControl(taskId: number, action: "stop" | "kill", actorName = "marek"): Promise<Task> {
  return api(`/tasks/${taskId}/control`, {
    method: "POST",
    body: JSON.stringify({ actorType: "human", actorName, action }),
  });
}

// I5: budget/burn-rate view. costUsd lives on `handoffs`, aggregated
// server-side (app/src/usage.ts) - see that file's note on why raw SQL.
export interface DailyCost {
  day: string; // YYYY-MM-DD
  costUsd: number;
  count: number;
}

export interface UsageSummary {
  todayUsd: number;
  // since the operator's configured weekly reset, not a fixed
  // Mon-00:00 calendar week - see app/src/usage.ts's UsageSummary note.
  sinceResetUsd: number;
  resetStart: string;
  monthUsd: number;
  daily: DailyCost[];
  // The figures above are agent spend; this is the operator's own
  // interactive sessions over the same ranges, never part of the budget gate.
  interactive: { todayUsd: number; sinceResetUsd: number; monthUsd: number };
}

export function getUsageSummary(): Promise<UsageSummary> {
  return api("/usage/summary");
}

// cost per task, rolled up per project and per parent project.
export interface TaskCost {
  taskId: number;
  title: string;
  projectId: number;
  totalCostUsd: number;
  sinceResetCostUsd: number;
}

export interface ProjectCost {
  projectId: number;
  slug: string;
  name: string;
  parentProjectId: number | null;
  ownCostUsd: number;
  ownSinceResetCostUsd: number;
  rolledUpCostUsd: number;
  rolledUpSinceResetCostUsd: number;
}

export interface CostRollup {
  resetStart: string;
  tasks: TaskCost[];
  projects: ProjectCost[];
}

export function getCostRollup(): Promise<CostRollup> {
  return api("/usage/rollup");
}

export interface WeeklyResetSetting {
  dayOfWeek: number; // 0=Sunday..6=Saturday
  hour: number; // 0-23, server-local time
}

export function getWeeklyResetSetting(): Promise<WeeklyResetSetting> {
  return api("/settings/weekly-reset");
}

export function updateWeeklyResetSetting(setting: WeeklyResetSetting): Promise<WeeklyResetSetting> {
  return api("/settings/weekly-reset", { method: "PUT", body: JSON.stringify(setting) });
}

export interface DigestSendResult {
  sent: boolean;
  reason?: string;
}

export function sendDigestNow(): Promise<DigestSendResult> {
  return api("/usage/digest/send", { method: "POST", body: JSON.stringify({}) });
}

// I6: governor and concurrency limits - see app/src/governor.ts for the
// full model this mirrors.
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

export interface ScopeStatus {
  scope: Scope;
  latestObservation: Observation | null;
  ageMs: number | null;
  availablePercent: number | null;
  state: GovernorState;
  costSinceObservationUsd: number | null;
  impliedDollarsPerPercent: number | null;
  estimatedPercentUsedSinceObservation: number | null;
}

export interface ExecutingTask {
  taskId: number;
  projectId: number;
  actorName: string | null;
  provider: string | null;
}

export interface GovernorStatus {
  week: ScopeStatus;
  session: ScopeStatus;
  state: GovernorState;
  reserveFloorPercent: number;
  thresholds: { overRatePercent: number; dangerPercent: number; criticalPercent: number; priorityGate: number };
  nextWeeklyResetAt: string;
  hoursUntilWeeklyReset: number;
  concurrency: {
    limits: { global: number; perAgent: number; perProject: number; perProvider: number };
    executing: ExecutingTask[];
  };
}

export function getGovernorStatus(): Promise<GovernorStatus> {
  return api("/governor/status");
}

export function getObservations(scope?: Scope, limit = 20): Promise<Observation[]> {
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  params.set("limit", String(limit));
  return api(`/governor/observations?${params.toString()}`);
}

export function recordObservation(scope: Scope, percentRemaining: number, note?: string): Promise<Observation> {
  return api("/governor/observations", { method: "POST", body: JSON.stringify({ scope, percentRemaining, note }) });
}

// I16: $-to-% budget rate tracking - see app/src/governor.ts's BudgetRate.
export interface BudgetRate {
  id: number;
  usdPerSessionPercent: number;
  usdPerWeekPercent: number;
  effectiveFrom: string;
  note: string | null;
  createdAt: string;
}

export function getBudgetRates(limit = 20): Promise<BudgetRate[]> {
  return api(`/governor/rates?limit=${limit}`);
}

export function recordBudgetRate(
  usdPerSessionPercent: number,
  usdPerWeekPercent: number,
  note?: string,
): Promise<BudgetRate> {
  return api("/governor/rates", { method: "POST", body: JSON.stringify({ usdPerSessionPercent, usdPerWeekPercent, note }) });
}

// plain date+rate log of every rate change, for charting drift.
export interface BudgetRateHistoryEntry {
  id: number;
  usdPerSessionPercent: number;
  usdPerWeekPercent: number;
  recordedAt: string;
}

export function getBudgetRateHistory(limit = 50): Promise<BudgetRateHistoryEntry[]> {
  return api(`/governor/rate-history?limit=${limit}`);
}

// PLAN.md's I8: planning chat passthrough - foreman polls for
// awaitingAgent threads and replies via `claude -p --resume`, never a
// direct connection from this PWA to a session on foreman. I9 reuses the
// same table/API for task-scoped session chat (taskId set instead of/
// alongside projectId) - see routes.ts's /chat/threads taskId filter.
export interface ChatThread {
  id: number;
  projectId: number | null;
  taskId: number | null;
  agentId: number | null;
  // per-thread overrides of the agent's own model, plus a
  // reasoning-effort hint - null keeps foreman's existing defaults.
  model: "sonnet" | "opus" | null;
  effort: "medium" | "high" | null;
  title: string;
  status: "open" | "closed";
  awaitingAgent: boolean;
  claudeSessionId: string | null;
  // this thread's own accumulated usage bucket - see
  // POST /chat/threads/:id/usage. totalCostUsd is a string (Postgres
  // numeric-as-text, same precedent as handoffs.costUsd/tasks.actualCostUsd).
  totalCostUsd: string;
  totalDurationMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: number;
  threadId: number;
  role: "human" | "agent";
  body: string;
  createdAt: string;
}

export interface ChatThreadFilter {
  taskId?: number | "none";
  status?: "open" | "closed";
}

export function getChatThreads(filter: ChatThreadFilter = {}): Promise<ChatThread[]> {
  const params = new URLSearchParams();
  if (filter.taskId !== undefined) params.set("taskId", String(filter.taskId));
  if (filter.status !== undefined) params.set("status", filter.status);
  const qs = params.toString();
  return api(`/chat/threads${qs ? `?${qs}` : ""}`);
}

export function getChatThread(id: number): Promise<ChatThread> {
  return api(`/chat/threads/${id}`);
}

export function createChatThread(
  title: string,
  projectId?: number,
  agentId?: number,
  model?: "sonnet" | "opus",
  effort?: "medium" | "high",
): Promise<ChatThread> {
  return api("/chat/threads", { method: "POST", body: JSON.stringify({ title, projectId, agentId, model, effort }) });
}

// I9: the task's current session chat thread, if any - null on 404 (no
// thread yet is the common case, not an error) rather than throwing.
export async function getTaskChatThread(taskId: number): Promise<ChatThread | null> {
  const resp = await fetch(`${API_BASE}/tasks/${taskId}/chat-thread`);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || body.message || `/tasks/${taskId}/chat-thread -> ${resp.status}`);
  }
  return resp.json();
}

export function getChatMessages(threadId: number): Promise<ChatMessage[]> {
  return api(`/chat/threads/${threadId}/messages`);
}

export function sendChatMessage(threadId: number, body: string): Promise<ChatMessage> {
  return api(`/chat/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ role: "human", body }) });
}

export function closeChatThread(threadId: number): Promise<ChatThread> {
  return api(`/chat/threads/${threadId}`, { method: "PATCH", body: JSON.stringify({ status: "closed" }) });
}

// rename affordance for the title auto-generated from a thread's
// first message.
export function renameChatThread(threadId: number, title: string): Promise<ChatThread> {
  return api(`/chat/threads/${threadId}`, { method: "PATCH", body: JSON.stringify({ title }) });
}

// --- the live transcript half of a chat thread -------------------
// Backed by a past task's routes and written by foreman's Agent SDK daemon
// (#148). `ChatEvent` itself lives in chat-transcript.ts with the folding
// logic that consumes it, so the mapping can be reasoned about without this
// file's fetch wrappers.

/** Everything since `since` (an event id); omit it for the whole transcript. */
export function getChatEvents(threadId: number, since?: number): Promise<ChatEvent[]> {
  const qs = since !== undefined && since > 0 ? `?since=${since}` : "";
  return api(`/chat/threads/${threadId}/events${qs}`);
}

export interface ChatPermissionRule {
  id: number;
  threadId: number;
  toolName: string;
  ruleContent: string | null;
  behavior: "allow" | "deny" | "ask";
  scope: "thread" | "turn";
  turn: number | null;
  createdAt: string;
  revokedAt: string | null;
}

/** What "don't ask again" has granted this thread and not yet had revoked. */
export function getChatPermissionRules(threadId: number): Promise<ChatPermissionRule[]> {
  return api(`/chat/threads/${threadId}/permission-rules`);
}

/** Revokes rather than deletes - the record of what was approved is the point. */
export function revokeChatPermissionRule(threadId: number, ruleId: number): Promise<ChatPermissionRule> {
  return api(`/chat/threads/${threadId}/permission-rules/${ruleId}`, { method: "DELETE" });
}

export interface PermissionDecisionInput {
  requestId: string;
  behavior: "allow" | "deny";
  /**
   * The Agent SDK's own `PermissionUpdate[]` - in practice the request's own
   * `suggestions` array handed straight back, which is what makes an
   * "always allow" outlive the turn. Never synthesised here: foreman feeds
   * this directly into the SDK, so a rule this app invented would grant
   * something the SDK never offered.
   */
  updatedPermissions?: unknown[] | null;
  message?: string;
}

// A live session is parked inside the SDK's canUseTool waiting for exactly
// this, keyed by requestId - hence its own route rather than a chat message.
export function sendPermissionDecision(
  threadId: number,
  decision: PermissionDecisionInput,
): Promise<{ requestId: string; behavior: string; delivered: number }> {
  return api(`/chat/threads/${threadId}/permission-decision`, { method: "POST", body: JSON.stringify(decision) });
}

export interface QuestionAnswerInput {
  requestId: string;
  /** Keyed by the question's own text, which is the key the SDK's
   *  AskUserQuestion schema uses. A multi-select answer is the chosen labels
   *  joined with a comma; an "Other" answer is the free text typed instead. */
  answers: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }> | null;
}

/** the answer a live session is parked on inside canUseTool. */
export function sendQuestionAnswer(
  threadId: number,
  answer: QuestionAnswerInput,
): Promise<{ requestId: string; delivered: number }> {
  return api(`/chat/threads/${threadId}/question-answer`, { method: "POST", body: JSON.stringify(answer) });
}

/** The Stop button: a signal on the stream, not a status foreman polls for. */
export function interruptChatThread(threadId: number): Promise<{ ok: boolean; delivered: number }> {
  return api(`/chat/threads/${threadId}/interrupt`, { method: "POST", body: JSON.stringify({}) });
}

// --- budget-driven work plan ------------------------------------
// Mirrors app/src/plan.ts's PlanResult. Kept in sync by hand, same as every
// other interface in this file.

export type EstimateBasis = "effort" | "project-mean" | "global-mean" | "default";
export type PacingMode = "unthrottled" | "throttled";
export type BindingConstraint = "budget" | "time" | "queue" | "none";
export type LoadVerdict = "underloaded" | "balanced" | "overloaded" | "unknown";

export interface PlannedTask {
  taskId: number;
  title: string;
  projectId: number;
  priority: number;
  estimatedCostUsd: number;
  estimateBasis: EstimateBasis;
  running: boolean;
}

export interface PlanSlot {
  startsAt: string;
  endsAt: string;
  // False only for the session window that is actually open right now.
  hypothetical: boolean;
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
  coverage: number;
  verdict: LoadVerdict;
  unspendableUsd: number;
  idleSlots: number;
  runnableTaskCount: number;
  deferredTaskCount: number;
  blockedTaskCount: number;
}

export interface PlannerSettings {
  sessionBudgetUsd: number;
  defaultTaskCostUsd: number;
  concurrencyGlobal: number;
}

export interface BudgetPeriod {
  id: number;
  startsAt: string;
  endsAt: string;
  budgetUsd: number;
  note: string | null;
  createdAt: string;
}

export interface Plan {
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
    // nextEndsAt is where the next auto-created week will end.
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
  pace: { mode: PacingMode; perSlotUsd: number; slotCount: number };
  binding: BindingConstraint;
  slots: PlanSlot[];
  load: PlanLoad;
  costModel: {
    globalMeanUsd: number | null;
    usdPerEffortPoint: number | null;
    meanDurationMs: number | null;
    sampleCount: number;
    useEffortScaling: boolean;
  };
  settings: PlannerSettings;
  // `seat` is the selected license's own limit (its override, else
  // the global default); `global` the cross-seat cap. Both apply.
  concurrency: { global: number; seat: number; seatRunning: number };
  startable: { tasks: PlannedTask[]; waitUntil: string | null; reason: string | null };
}

// the plan is per license - each seat has its own budget period and
// session window. Omitting the id still answers for the default license (what
// every caller did before a second seat existed).
export function getPlan(licenseId?: number): Promise<Plan> {
  return api(licenseId === undefined ? "/plan" : `/plan?licenseId=${licenseId}`);
}

export function getBudgetPeriods(limit = 20): Promise<BudgetPeriod[]> {
  return api(`/plan/periods?limit=${limit}`);
}

export function createBudgetPeriod(input: {
  budgetUsd: number;
  endsAt: string;
  startsAt?: string;
  note?: string;
  licenseId?: number;
}): Promise<BudgetPeriod> {
  return api("/plan/periods", { method: "POST", body: JSON.stringify(input) });
}

export function updateBudgetPeriod(
  id: number,
  patch: { budgetUsd?: number; endsAt?: string; startsAt?: string; note?: string | null },
): Promise<BudgetPeriod> {
  return api(`/plan/periods/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function getPlannerSettings(): Promise<PlannerSettings> {
  return api("/settings/planner");
}

export function updatePlannerSettings(patch: Partial<PlannerSettings>): Promise<PlannerSettings> {
  return api("/settings/planner", { method: "PUT", body: JSON.stringify(patch) });
}

// the journal (app/src/journal.ts) - every task, project, chat
// and config change, newest first.
export interface JournalEvent {
  id: number;
  taskId: number | null;
  projectId: number | null;
  eventType: string;
  actorType: string;
  actorName: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  taskTitle: string | null;
  projectSlug: string | null;
}

export function getJournal(
  q: { taskId?: number; projectId?: number; beforeId?: number; limit?: number; types?: string } = {},
): Promise<JournalEvent[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return api(`/events${qs ? `?${qs}` : ""}`);
}

export type NotificationKind = "failure" | "review" | "approval" | "question" | "completed";

export interface AppNotification {
  id: number;
  eventId: number | null;
  taskId: number | null;
  projectId: number | null;
  kind: NotificationKind;
  title: string;
  body: string | null;
  url: string | null;
  readAt: string | null;
  createdAt: string;
}

export function getNotifications(q: { unread?: boolean; beforeId?: number; limit?: number } = {}): Promise<AppNotification[]> {
  const params = new URLSearchParams();
  if (q.unread) params.set("unread", "true");
  if (q.beforeId !== undefined) params.set("beforeId", String(q.beforeId));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const qs = params.toString();
  return api(`/notifications${qs ? `?${qs}` : ""}`);
}

export function getUnreadNotificationCount(): Promise<{ unread: number }> {
  return api("/notifications/unread-count");
}

export function markNotificationRead(id: number): Promise<void> {
  return api(`/notifications/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead(): Promise<void> {
  return api("/notifications/read-all", { method: "POST" });
}

// one test publish to pinboard's ntfy topic.
export function sendTestPush(): Promise<{ sent: boolean }> {
  return api("/push/test", { method: "POST" });
}

// the releases view.
export interface DeployTarget {
  id: number;
  projectId: number;
  host: string;
  app: string;
  deployedSha: string | null;
  mainSha: string | null;
  pendingCount: number | null;
  pendingCommits: { sha: string; subject: string }[] | null;
  probeError: string | null;
  // a human-gated production release target, and the image tag it runs.
  release: boolean;
  deployedVersion: string | null;
  checkedAt: string;
}

export type DeployRequestStatus = "queued" | "running" | "succeeded" | "failed";

export interface DeployRequest {
  id: number;
  projectId: number;
  status: DeployRequestStatus;
  kind: "deploy" | "release";
  bump: ReleaseBump | null;
  version: string | null;
  requestedBy: string;
  output: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReleaseProject {
  id: number;
  slug: string;
  name: string;
  localPath: string | null;
  targets: DeployTarget[];
  lastRequest: DeployRequest | null;
}

export function getReleases(): Promise<ReleaseProject[]> {
  return api("/releases");
}

export function requestDeploy(projectId: number): Promise<DeployRequest> {
  return api(`/releases/${projectId}/deploy`, { method: "POST", body: "{}" });
}

export type ReleaseBump = "patch" | "minor" | "major";

export function requestRelease(projectId: number, bump: ReleaseBump): Promise<DeployRequest> {
  return api(`/releases/${projectId}/release`, { method: "POST", body: JSON.stringify({ bump }) });
}

// What a bump would turn "v0.2.0" into, for the release menu. foreman computes
// the real one from the app's package.json; this is only the preview.
export function bumpedVersion(version: string | null, bump: ReleaseBump): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!m) return null;
  const [major, minor, patch] = m.slice(1).map(Number);
  if (bump === "major") return `v${major + 1}.0.0`;
  if (bump === "minor") return `v${major}.${minor + 1}.0`;
  return `v${major}.${minor}.${patch + 1}`;
}

// structured asks - a question with options (exactly one
// recommended) or an assumption the agent went ahead with.
export interface AskOption {
  label: string;
  rationale: string | null;
  recommended: boolean;
}

export interface Ask {
  id: number;
  taskId: number;
  threadId: number | null;
  kind: "question" | "assumption";
  context: string | null;
  question: string;
  options: AskOption[];
  defaultOption: number | null;
  status: "open" | "answered" | "vetoed" | "accepted";
  answerOption: number | null;
  answerText: string | null;
  answeredAt: string | null;
  createdAt: string;
  // Joined in by GET /asks.
  taskTitle: string;
  taskStatus: string;
  projectId: number;
  projectSlug: string;
  projectName: string;
}

// An ask as GET /tasks/:id embeds it, without GET /asks's joined fields.
export type TaskAsk = Omit<Ask, "taskTitle" | "taskStatus" | "projectId" | "projectSlug" | "projectName">;

export function getAsks(status: Ask["status"][]): Promise<Ask[]> {
  return api(`/asks?status=${status.join(",")}`);
}

export function answerAsk(id: number, input: { option?: number | null; text?: string }): Promise<unknown> {
  return api(`/asks/${id}/answer`, { method: "POST", body: JSON.stringify(input) });
}

export function vetoAsk(id: number, text: string): Promise<unknown> {
  return api(`/asks/${id}/veto`, { method: "POST", body: JSON.stringify({ text }) });
}

export function answerRecommendedAsks(): Promise<{ answered: number }> {
  return api("/asks/answer-recommended", { method: "POST", body: JSON.stringify({}) });
}

export interface Handoff {
  id: number;
  taskId: number;
  completed: string | null;
  changed: string | null;
  verified: string | null;
  problems: string | null;
  discovered: string | null;
  next: string | null;
  summary: string | null;
  costUsd: string | null;
  createdAt: string;
}

// Newest first.
export function getHandoffs(taskId: number): Promise<Handoff[]> {
  return api(`/tasks/${taskId}/handoffs`);
}
