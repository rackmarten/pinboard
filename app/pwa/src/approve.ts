import type { PullRequest } from "./api.js";

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
