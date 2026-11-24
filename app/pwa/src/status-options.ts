// What a status picker offers, and what a task in a system status offers
// instead. The lists themselves are the API's (app/src/task-status.ts), so
// the select and PATCH /tasks/:id agree on what may be set by hand.
import { MANUAL_STATUSES, STORY_STATUSES, isSystemStatus } from "./api.js";

// The statuses a picker offers for a task: a story's three, otherwise the
// manual ones. Empty when the task sits in a system status, which is shown
// read-only with actions instead (systemStatusActions).
export function statusOptions(task: { status: string; taskType: string }): readonly string[] {
  if (task.taskType === "story") return STORY_STATUSES;
  return isSystemStatus(task.status) ? [] : MANUAL_STATUSES;
}

// Whether a task's status is shown read-only. A story has no workflow
// status of its own, so it always keeps its select.
export function statusReadOnly(task: { status: string; taskType: string }): boolean {
  return task.taskType !== "story" && isSystemStatus(task.status);
}

// approve: the review queue's Approve (merge, release a hold, or accept).
// answer: go to the open question. pull_out: -> rework with a comment.
// reject: -> rejected.
export type SystemStatusAction = "approve" | "answer" | "pull_out" | "reject";

export function systemStatusActions(status: string): SystemStatusAction[] {
  if (!isSystemStatus(status)) return [];
  if (status === "review") return ["approve", "pull_out", "reject"];
  if (status === "needs_input") return ["answer", "pull_out", "reject"];
  return ["pull_out", "reject"];
}

// The line a read-only status shows next to its actions.
export function systemStatusNote(status: string): string {
  if (status === "in_progress") return "Being worked on. It moves on by itself when the run ends.";
  if (status === "needs_input") return "Waiting for an answer to its question.";
  if (status === "review") return "Waiting for your approval before it lands.";
  return `In the pipeline (${status.replace("_", " ")}). foreman moves it on by itself.`;
}

// Where Answer goes: an open question (a `work task ask`) is answered in
// the inbox; one the agent asked in its session chat, in that chat.
export function answerLink(openAskCount: number, sessionThreadId: number | null): string {
  if (!openAskCount && sessionThreadId !== null) return `/chat/${sessionThreadId}`;
  return "/inbox";
}

// The comment a Pull out or Reject posts before it moves the task.
export function moveComment(action: "pull_out" | "reject", from: string, text: string): string {
  const head = action === "pull_out" ? `Pulled out of ${from} into rework` : `Rejected from ${from}`;
  return text.trim() ? `${head}: ${text.trim()}` : `${head}.`;
}
