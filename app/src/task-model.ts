// the task vocabulary the API validates against. The PWA keeps its
// own copy in pwa/src/api.ts (it's a separate Vite build that can't import
// from here - see the Dockerfile), so a change to either list needs the other.
export const TASK_STATUSES = [
  "idea",
  "defined",
  "queued",
  // being worked on, by a person (a claim) or an agent run (a leased claim).
  "in_progress",
  // an agent paused on an unanswered question (see pipeline.ts).
  "needs_input",
  "awaiting_ci",
  "awaiting_merge",
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
  // a parent task grouping ordered increments. Never runnable
  // itself (plan.ts's rankRunnableTasks skips it by type); it moves to done
  // on its own once every child is done or rejected (storyShouldComplete
  // below). It has no workflow status of its own: stored as defined while
  // open, and what the UI shows is storyRollup's phase.
  "story",
] as const;

export const EXECUTOR_MODES = ["human", "agent", "human+agent"] as const;

const TERMINAL = new Set(["done", "rejected"]);

export type EnumCheck = { ok: true; value?: string } | { ok: false; reason: string };

function oneOf(field: string, allowed: readonly string[], value: unknown): EnumCheck {
  if (value === undefined) return { ok: true };
  if (typeof value === "string" && allowed.includes(value)) return { ok: true, value };
  return { ok: false, reason: `${field} must be one of ${allowed.join(", ")}` };
}

// Old names a caller may still send, mapped to the status they mean now.
// `backlog` and `todo` were never real statuses but scripts and older skill
// text send them for "written down, not yet ready"; `planned`, `executing`
// and `awaiting_review` were removed by migration 0049, and a foreman or
// script that predates it keeps working through these. `decomposed` was a
// story's label until migration 0050 made every story plain defined.
export const STATUS_ALIASES: Readonly<Record<string, string>> = {
  backlog: "defined",
  todo: "defined",
  planned: "defined",
  executing: "in_progress",
  awaiting_review: "review",
  decomposed: "defined",
};

// What migration 0049 did to stored rows: every alias above but decomposed
// (0050's), plus `handoff` (an event now, not a status) to rework, with a
// comment. The test checks the SQL against this.
const { decomposed: _decomposed, ...aliasesBefore0050 } = STATUS_ALIASES;
export const STATUS_MIGRATION: Readonly<Record<string, string>> = { ...aliasesBefore0050, handoff: "rework" };

export function canonicalStatus(status: string): string {
  return STATUS_ALIASES[status] ?? status;
}

// Validates the enum fields of a POST/PATCH /tasks body in place, rewriting
// an aliased status (STATUS_ALIASES) to its current name first.
export function normalizeTaskEnums(body: Record<string, unknown>): EnumCheck {
  if (typeof body.status === "string") body.status = canonicalStatus(body.status);
  for (const [field, allowed] of [
    ["status", TASK_STATUSES],
    ["taskType", TASK_TYPES],
    ["executorMode", EXECUTOR_MODES],
  ] as const) {
    if (!(field in body)) continue;
    const check = oneOf(field, allowed, body[field]);
    if (!check.ok) return check;
  }
  return { ok: true };
}

export interface RelationRow {
  fromTaskId: number;
  toTaskId: number;
  relationType: string;
}

// Parent/child rows exist in both directions (see TaskDetailView.vue's
// findParentId): (X, "parent", P) and (P, "child", X) both mean P is X's
// parent. Returns child id -> parent id; the first row seen wins.
export function parentMap(relations: readonly RelationRow[]): Map<number, number> {
  const parents = new Map<number, number>();
  for (const r of relations) {
    const pair =
      r.relationType === "parent" ? [r.fromTaskId, r.toTaskId] : r.relationType === "child" ? [r.toTaskId, r.fromTaskId] : null;
    if (pair && !parents.has(pair[0])) parents.set(pair[0], pair[1]);
  }
  return parents;
}

// A story with no children is left alone; otherwise it's done once every
// child is done or rejected (and it isn't already terminal itself).
export function storyShouldComplete(storyStatus: string, childStatuses: readonly string[]): boolean {
  return !TERMINAL.has(storyStatus) && childStatuses.length > 0 && childStatuses.every((s) => TERMINAL.has(s));
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status);
}

// The phases the UI groups statuses into (the kanban columns to come).
// rejected sits in Done, hidden by default.
export const TASK_PHASES = ["backlog", "ready", "in_progress", "pipeline", "needs_you", "done"] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const STATUS_PHASES: Readonly<Record<(typeof TASK_STATUSES)[number], TaskPhase>> = {
  idea: "backlog",
  defined: "backlog",
  queued: "ready",
  in_progress: "in_progress",
  awaiting_ci: "pipeline",
  awaiting_merge: "pipeline",
  deploying: "pipeline",
  verifying: "pipeline",
  needs_input: "needs_you",
  review: "needs_you",
  rework: "needs_you",
  done: "done",
  rejected: "done",
};

export function statusPhase(status: string): TaskPhase {
  return STATUS_PHASES[canonicalStatus(status) as keyof typeof STATUS_PHASES] ?? "backlog";
}

// What a story shows instead of a status: its children counted per phase
// (rejected ones left out, like the done/total progress; zero counts
// omitted to keep the task list small) and one phase for the whole story.
export interface StoryRollup {
  phase: TaskPhase;
  counts: Partial<Record<TaskPhase, number>>;
}

// The first phase any open child is in wins, in this order: a child waiting
// on a human outranks one being worked on, which outranks one in the
// pipeline, then one queued. A closed story, or one whose children are all
// done or rejected, is done; one with no children is backlog.
const STORY_PHASE_ORDER: readonly TaskPhase[] = ["needs_you", "in_progress", "pipeline", "ready", "backlog"];

export function storyRollup(storyStatus: string, childStatuses: readonly string[]): StoryRollup {
  const counts: Partial<Record<TaskPhase, number>> = {};
  for (const status of childStatuses) {
    if (status === "rejected") continue;
    const phase = statusPhase(status);
    counts[phase] = (counts[phase] ?? 0) + 1;
  }
  if (TERMINAL.has(storyStatus) || (childStatuses.length > 0 && childStatuses.every((s) => TERMINAL.has(s)))) {
    return { phase: "done", counts };
  }
  return { phase: STORY_PHASE_ORDER.find((p) => counts[p]) ?? "backlog", counts };
}

// whether a depends_on target no longer holds its dependent back.
// done/rejected always satisfy; so does a task parked in `review` whose PRs
// are all merged (at least one), since its change is already on main and only
// the human sign-off is left. dependencyGate() below builds on it.
export function dependencySatisfied(status: string, prStates: readonly string[]): boolean {
  if (TERMINAL.has(status)) return true;
  return status === "review" && prStates.length > 0 && prStates.every((s) => s === "merged");
}

// how a project's review step works. `standard` is review as a code review:
// a dependent waits until its target's change is on main. `playtest` is for
// projects (games) whose review is playing a build: a dependent may start on
// top of one target that is still in review with an open PR, and foreman
// stacks its branch on that PR's branch (see dependencyGate).
export const REVIEW_MODES = ["standard", "playtest"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export function isReviewMode(value: unknown): value is ReviewMode {
  return typeof value === "string" && (REVIEW_MODES as readonly string[]).includes(value);
}

// a task's reasoning effort for foreman's run: its own setting, else its
// project's default, else null (foreman's default). Same values as a chat
// thread's effort.
export const REASONING_EFFORTS = ["medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function effectiveReasoningEffort(taskEffort: string | null, projectDefault: string | null | undefined): string | null {
  return taskEffort ?? projectDefault ?? null;
}

export interface DependencyTarget {
  taskId: number;
  status: string;
  prStates: readonly string[];
}

// a target a playtest dependent can be stacked on: waiting in review with an
// open PR whose branch the dependent can be cut from.
function stackable(target: DependencyTarget): boolean {
  return target.status === "review" && target.prStates.includes("open");
}

export type DependencyGate = { blocked: true } | { blocked: false; stackOnTaskId: number | null };

// whether a task's depends_on targets let it run, and in a playtest project
// which target (if any) its branch has to be stacked on. At most one
// unmerged target: two would mean merging one parent's branch into a PR
// based on the other's, so a task with two waits as it always has.
// plan.ts's blockedTaskIds() and the task route's stackOn both use this.
export function dependencyGate(mode: ReviewMode, targets: readonly DependencyTarget[]): DependencyGate {
  const open = targets.filter((t) => !dependencySatisfied(t.status, t.prStates));
  if (open.length === 0) return { blocked: false, stackOnTaskId: null };
  if (mode === "playtest" && open.length === 1 && stackable(open[0])) return { blocked: false, stackOnTaskId: open[0].taskId };
  return { blocked: true };
}

// task ids among a dependent's `targets` that still have to merge before its
// own PR may: in a playtest project a stacked PR is based on its parent's
// branch, so merging it first would land the parent's unreviewed work too.
export function unmergedDependencies(targets: readonly DependencyTarget[]): number[] {
  return targets.filter((t) => !dependencySatisfied(t.status, t.prStates)).map((t) => t.taskId);
}
