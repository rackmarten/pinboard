import { describe, expect, it } from "vitest";
import { approveAction } from "./approve.js";

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
