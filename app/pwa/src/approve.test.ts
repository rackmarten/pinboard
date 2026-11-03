import { describe, expect, it } from "vitest";
import { approveAction, approveWarningComment, canConfirmApprove, checkedCountLabel, needsApproveWarning, uncheckedItems } from "./approve.js";

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
