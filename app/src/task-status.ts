// The task statuses, the phases the UI groups them into, and which of them a
// person may set by hand. The one copy both sides use: the API imports it
// from here, and the PWA imports this same file (../../src/task-status.js;
// the Dockerfile copies it into the PWA's build stage). Keep it free of Node
// and server imports so the browser build can take it as it is.
export const TASK_STATUSES = [
  "idea",
  "defined",
  "queued",
  // being worked on, by a person (a claim) or an agent run (a leased claim).
  "in_progress",
  // an agent paused on an unanswered question (see pipeline.ts).
  "needs_input",
  // the post-PR pipeline, driven by foreman's poller (see pipeline.ts).
  "awaiting_ci",
  "awaiting_merge",
  "deploying",
  "verifying",
  // a human approves the result before it lands.
  "review",
  "rework",
  "done",
  "rejected",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

// What a person may pick: the select, the bulk edit, PATCH /tasks/:id and
// `work task update --status`. Every other status means something happened
// (a claim, a question, a pipeline stage), so it is only reached by the call
// that makes it happen; systemStatusRoute below names that call.
export const MANUAL_STATUSES = ["idea", "defined", "queued", "rework", "done", "rejected"] as const satisfies readonly TaskStatus[];

// The statuses a story is stored in: it has no workflow status of its own.
export const STORY_STATUSES = ["defined", "done", "rejected"] as const satisfies readonly TaskStatus[];

export function isManualStatus(status: string): boolean {
  return (MANUAL_STATUSES as readonly string[]).includes(status);
}

// The statuses only a claim, the runner or the pipeline sets.
export const SYSTEM_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter((s) => !isManualStatus(s));

export function isSystemStatus(status: string): boolean {
  return (SYSTEM_STATUSES as readonly string[]).includes(status);
}

// The right way into a system status, for the 400 a PATCH to one gets.
export function systemStatusRoute(status: string): string {
  if (status === "in_progress") return "in_progress is set by claiming the task: POST /api/tasks/:id/claim (work task claim <id>)";
  if (status === "needs_input") {
    return "needs_input is set when an agent's question goes unanswered: POST /api/tasks/:id/pipeline from queued or in_progress";
  }
  if (status === "review") {
    return "review is set by the run or the pipeline: POST /api/tasks/:id/pipeline (from in_progress, or awaiting_ci with a reviewReason)";
  }
  return `${status} is a pipeline stage, moved by foreman's poller: POST /api/tasks/:id/pipeline`;
}

// The phases the UI groups statuses into (the kanban columns to come).
// rejected sits in Done, hidden by default.
export const TASK_PHASES = ["backlog", "ready", "in_progress", "pipeline", "needs_you", "done"] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const STATUS_PHASES: Readonly<Record<TaskStatus, TaskPhase>> = {
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

// Each phase's statuses, in TASK_STATUSES order.
export const PHASE_STATUSES = Object.fromEntries(
  TASK_PHASES.map((phase) => [phase, TASK_STATUSES.filter((s) => STATUS_PHASES[s] === phase)]),
) as unknown as Readonly<Record<TaskPhase, readonly TaskStatus[]>>;

// The statuses a set of phases covers, e.g. a phase filter's.
export function phasesToStatuses(phases: readonly string[]): TaskStatus[] {
  return TASK_STATUSES.filter((s) => phases.includes(STATUS_PHASES[s]));
}

export function isTaskPhase(value: string): value is TaskPhase {
  return (TASK_PHASES as readonly string[]).includes(value);
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

export function canonicalStatus(status: string): string {
  return STATUS_ALIASES[status] ?? status;
}

export function statusPhase(status: string): TaskPhase {
  return STATUS_PHASES[canonicalStatus(status) as TaskStatus] ?? "backlog";
}
