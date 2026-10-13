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
// the human sign-off is left. plan.ts's blockedTaskIds() is the SQL twin.
export function dependencySatisfied(status: string, prStates: readonly string[]): boolean {
  if (TERMINAL.has(status)) return true;
  return status === "review" && prStates.length > 0 && prStates.every((s) => s === "merged");
}
