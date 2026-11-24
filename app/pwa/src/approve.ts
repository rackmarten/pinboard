import type { ChecklistItem, PullRequest } from "./api.js";

// what "Approve" does. A pre-merge hold is released; a task that
// still has an open PR row is merged by the pipeline (review -> awaiting_merge)
// rather than closed over an unmerged branch; anything else is marked done.
export type ApproveAction = "release_hold" | "merge" | "complete";

export function hasOpenPr(prs: readonly Pick<PullRequest, "state">[]): boolean {
  return prs.some((pr) => pr.state !== "merged" && pr.state !== "closed");
}

export function approveAction(preMergeHold: boolean, prs: readonly Pick<PullRequest, "state">[]): ApproveAction {
  if (preMergeHold) return "release_hold";
  return hasOpenPr(prs) ? "merge" : "complete";
}

// The review checklist's part in approving: with any unticked item, Approve
// opens a warning dialog that needs a comment before it goes ahead.
export function uncheckedItems(items: readonly Pick<ChecklistItem, "item" | "checked">[]): string[] {
  return items.filter((i) => !i.checked).map((i) => i.item);
}

export function needsApproveWarning(items: readonly Pick<ChecklistItem, "item" | "checked">[]): boolean {
  return uncheckedItems(items).length > 0;
}

export function canConfirmApprove(comment: string): boolean {
  return comment.trim().length > 0;
}

// "3/5 checked" for the review card; null when there is no checklist.
export function checkedCountLabel(items: readonly Pick<ChecklistItem, "checked">[]): string | null {
  if (!items.length) return null;
  return `${items.filter((i) => i.checked).length}/${items.length} checked`;
}

// The comment posted on the task before an approve that skips items.
export function approveWarningComment(unchecked: readonly string[], comment: string): string {
  return [`Approved with ${unchecked.length} unchecked checklist item(s):`, ...unchecked.map((i) => `- ${i}`), "", comment.trim()].join("\n");
}

// A pre-merge hold: the PR waits for a human because its diff touches a
// migration (see app/src/pipeline.ts's REVIEW_REASONS).
export function isPreMergeHold(task: { reviewReason?: string | null }): boolean {
  return task.reviewReason === "migration";
}

export interface ApproveDeps {
  getPullRequests: (taskId: number) => Promise<Pick<PullRequest, "state">[]>;
  addComment: (taskId: number, body: string) => Promise<unknown>;
  advancePipeline: (taskId: number, to: string) => Promise<unknown>;
  approveTask: (taskId: number) => Promise<unknown>;
}

// Approve, wherever it is pressed (the review queue, a task's own page):
// release a hold, merge an open PR, or accept the result. `via` names where,
// for the comment.
export async function performApprove(task: { id: number; reviewReason?: string | null }, via: string, deps: ApproveDeps): Promise<ApproveAction> {
  const held = isPreMergeHold(task);
  const action = approveAction(held, held ? [] : await deps.getPullRequests(task.id));
  if (action === "release_hold") {
    await deps.addComment(task.id, `Pre-merge hold released via ${via} - the pipeline may merge and deploy this.`);
    await deps.advancePipeline(task.id, "awaiting_merge");
  } else if (action === "merge") {
    // move first: a stacked playtest PR is refused until its parent merges,
    // and the comment would then claim a merge that isn't happening.
    await deps.advancePipeline(task.id, "awaiting_merge");
    await deps.addComment(task.id, `Approved via ${via} - merging.`);
  } else {
    await deps.addComment(task.id, `Approved via ${via}.`);
    await deps.approveTask(task.id);
  }
  return action;
}
