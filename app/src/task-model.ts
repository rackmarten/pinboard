// the task vocabulary the API validates against. The PWA keeps its
// own copy in pwa/src/api.ts (it's a separate Vite build that can't import
// from here - see the Dockerfile), so a change to either list needs the other.
export const TASK_STATUSES = [
  "idea",
  "defined",
  "planned",
  "decomposed",
  "queued",
  "executing",
  // an agent paused on an unanswered question (see pipeline.ts).
  "needs_input",
  "handoff",
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
  // a parent task grouping ordered increments. Never runnable
  // itself (plan.ts's rankRunnableTasks skips it); it moves to done on its
  // own once every child is done or rejected (storyShouldComplete below).
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

// Validates the enum fields of a POST/PATCH /tasks body in place. `backlog`
// was never a real status, but the homelab scripts (and older skill text)
// still send it for "written down, not yet ready", so it's accepted as an
// alias of `defined` rather than breaking them; migration 0035 moved the rows
// that got stored before this check existed.
export function normalizeTaskEnums(body: Record<string, unknown>): EnumCheck {
  if (body.status === "backlog") body.status = "defined";
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
