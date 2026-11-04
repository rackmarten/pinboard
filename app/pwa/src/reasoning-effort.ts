// A task's reasoning effort for foreman's run (see app/src/task-model.ts's
// REASONING_EFFORTS), separate from the story-point estimatedEffort. Null
// means inherit: a task falls back to its project's default, a project to
// foreman's own default. Selects use a sentinel for null, since a v-select
// item whose value is null reads as "nothing selected".
export type ReasoningEffort = "medium" | "high";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["medium", "high"];

const INHERIT = "inherit";
export type ReasoningEffortField = ReasoningEffort | typeof INHERIT;

export function reasoningEffortItems(inheritTitle: string): { value: ReasoningEffortField; title: string }[] {
  return [
    { value: INHERIT, title: inheritTitle },
    { value: "medium", title: "Medium" },
    { value: "high", title: "High" },
  ];
}

export function toReasoningEffortField(value: ReasoningEffort | null | undefined): ReasoningEffortField {
  return value ?? INHERIT;
}

export function fromReasoningEffortField(field: ReasoningEffortField): ReasoningEffort | null {
  return field === INHERIT ? null : field;
}

// the task detail chip's text: "high" when the task sets it, "high
// (project)" when inherited, null when neither sets one.
export function reasoningEffortChip(task: {
  reasoningEffort: ReasoningEffort | null;
  effectiveReasoningEffort?: ReasoningEffort | null;
}): string | null {
  if (task.reasoningEffort) return task.reasoningEffort;
  return task.effectiveReasoningEffort ? `${task.effectiveReasoningEffort} (project)` : null;
}
