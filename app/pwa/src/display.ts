// I11: presentation-only helpers (colors/icons) shared across every view
// that lists or shows a task, so status/type/priority read consistently
// everywhere instead of each view inventing its own mapping (as
// TaskListView's own STATUS_COLORS did before this).

// mapped onto ui-kit's semantic palette (theme v2) instead of raw
// Vuetify colour names, so every status is tuned for both light and dark:
// grey = not started yet, info = waiting its turn, primary = running,
// secondary (the accent's hue neighbour) = the machine-driven post-PR
// pipeline, warning = waiting on a human, error = sent back,
// success = done.
export const STATUS_COLORS: Record<string, string> = {
  idea: "grey",
  defined: "grey",
  planned: "grey",
  decomposed: "grey",
  queued: "info",
  executing: "primary",
  needs_input: "deep-orange",
  handoff: "warning",
  awaiting_ci: "secondary",
  awaiting_merge: "secondary",
  awaiting_review: "warning",
  deploying: "secondary",
  verifying: "secondary",
  review: "warning",
  rework: "error",
  done: "success",
  rejected: "grey",
};

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "grey";
}

export const STATUS_ICONS: Record<string, string> = {
  idea: "mdi-lightbulb-outline",
  defined: "mdi-file-document-outline",
  planned: "mdi-calendar-outline",
  decomposed: "mdi-file-tree-outline",
  queued: "mdi-tray-full",
  executing: "mdi-cog-sync-outline",
  needs_input: "mdi-message-question-outline",
  handoff: "mdi-account-arrow-right-outline",
  awaiting_ci: "mdi-timer-sand",
  awaiting_merge: "mdi-source-merge",
  awaiting_review: "mdi-gate-alert",
  deploying: "mdi-rocket-launch-outline",
  verifying: "mdi-heart-pulse",
  review: "mdi-clipboard-check-outline",
  rework: "mdi-restart",
  done: "mdi-check-circle-outline",
  rejected: "mdi-cancel",
};

export function statusIcon(status: string): string {
  return STATUS_ICONS[status] ?? "mdi-circle-small";
}

export const TASK_TYPE_ICONS: Record<string, string> = {
  idea: "mdi-lightbulb-outline",
  research: "mdi-magnify",
  decision: "mdi-source-branch",
  architecture: "mdi-sitemap",
  implementation: "mdi-code-tags",
  bug: "mdi-bug-outline",
  testing: "mdi-flask-outline",
  review: "mdi-eye-check-outline",
  deployment: "mdi-rocket-launch-outline",
  maintenance: "mdi-wrench-outline",
  story: "mdi-book-open-page-variant-outline",
};

export function taskTypeIcon(taskType: string): string {
  return TASK_TYPE_ICONS[taskType] ?? "mdi-shape-outline";
}

// only `story` gets its own colour, so a story row stands out
// among the tasks it groups; every other type keeps the default text colour.
export const TASK_TYPE_COLORS: Record<string, string> = {
  story: "secondary",
};

export function taskTypeColor(taskType: string): string | undefined {
  return TASK_TYPE_COLORS[taskType];
}

export const EXECUTOR_MODE_ICONS: Record<string, string> = {
  human: "mdi-account-outline",
  agent: "mdi-robot-outline",
  "human+agent": "mdi-account-supervisor-outline",
};

export function executorModeIcon(mode: string): string {
  return EXECUTOR_MODE_ICONS[mode] ?? "mdi-account-outline";
}

// I15: linked PR state chip on the task detail view.
export const PR_STATE_COLORS: Record<string, string> = {
  open: "info",
  merged: "success",
  closed: "error",
};

export function prStateColor(state: string): string {
  return PR_STATE_COLORS[state] ?? "grey";
}

// Priority is a free integer (default 0, higher sorts first, no fixed
// upper bound - see app/src/db/schema.ts), so it's bucketed into a few
// visually distinct tiers rather than a literal color-per-number.
export function priorityColor(priority: number): string {
  if (priority >= 10) return "error";
  if (priority >= 5) return "warning";
  if (priority >= 1) return "info";
  return "grey";
}
