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
