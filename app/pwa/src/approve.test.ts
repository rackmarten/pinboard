import { describe, expect, it } from "vitest";
import { approveAction, approveWarningComment, canConfirmApprove, checkedCountLabel, needsApproveWarning, performApprove, uncheckedItems } from "./approve.js";

describe("approveAction", () => {
  it("releases a pre-merge hold", () => {
    expect(approveAction(true, [{ state: "open" }])).toBe("release_hold");
  });
  it("merges when any PR row is still open", () => {
    expect(approveAction(false, [{ state: "merged" }, { state: "open" }])).toBe("merge");
  });
  it("completes when every PR is merged or closed, or there is none", () => {
    expect(approveAction(false, [{ state: "merged" }, { state: "closed" }])).toBe("complete");
    expect(approveAction(false, [])).toBe("complete");
  });
});

describe("checklist approve warning", () => {
  const items = [
    { item: "Read the diff", checked: true },
    { item: "Try it on a phone", checked: false },
    { item: "Check the docs", checked: false },
  ];

  it("requires the dialog when any item is unticked, listing those items", () => {
    expect(needsApproveWarning(items)).toBe(true);
    expect(uncheckedItems(items)).toEqual(["Try it on a phone", "Check the docs"]);
  });
  it("approves as today when every item is ticked or there is no checklist", () => {
    expect(needsApproveWarning(items.map((i) => ({ ...i, checked: true })))).toBe(false);
    expect(needsApproveWarning([])).toBe(false);
  });
  it("needs a non-blank comment to confirm", () => {
    expect(canConfirmApprove("")).toBe(false);
    expect(canConfirmApprove("   ")).toBe(false);
    expect(canConfirmApprove("checked on desktop instead")).toBe(true);
  });
  it("posts the unticked items with the comment", () => {
    expect(approveWarningComment(["a", "b"], " fine ")).toBe("Approved with 2 unchecked checklist item(s):\n- a\n- b\n\nfine");
  });
  it("counts checked items, or nothing without a checklist", () => {
    expect(checkedCountLabel(items)).toBe("1/3 checked");
    expect(checkedCountLabel([])).toBeNull();
  });
});

describe("performApprove", () => {
  function deps(prs: { state: string }[]) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        getPullRequests: async () => prs as { state: "open" | "merged" | "closed" }[],
        addComment: async (_id: number, body: string) => calls.push(`comment: ${body}`),
        advancePipeline: async (_id: number, to: string) => calls.push(`pipeline: ${to}`),
        approveTask: async () => calls.push("complete"),
      },
    };
  }
  it("releases a migration hold without reading the PRs", async () => {
    const d = deps([{ state: "open" }]);
    expect(await performApprove({ id: 1, reviewReason: "migration" }, "the task page", d.deps)).toBe("release_hold");
    expect(d.calls).toEqual(["comment: Pre-merge hold released via the task page - the pipeline may merge and deploy this.", "pipeline: awaiting_merge"]);
  });
  it("moves an open PR to merge before saying so", async () => {
    const d = deps([{ state: "open" }]);
    expect(await performApprove({ id: 1, reviewReason: "no_auto_deploy" }, "review queue", d.deps)).toBe("merge");
    expect(d.calls).toEqual(["pipeline: awaiting_merge", "comment: Approved via review queue - merging."]);
  });
  it("accepts work with no open PR", async () => {
    const d = deps([]);
    expect(await performApprove({ id: 1, reviewReason: null }, "review queue", d.deps)).toBe("complete");
    expect(d.calls).toEqual(["comment: Approved via review queue.", "complete"]);
  });
});
