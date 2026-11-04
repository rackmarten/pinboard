import { describe, expect, it } from "vitest";
import { fromReasoningEffortField, reasoningEffortChip, reasoningEffortItems, toReasoningEffortField } from "./reasoning-effort.js";

describe("reasoning effort field", () => {
  it("maps null to the inherit item and back", () => {
    expect(toReasoningEffortField(null)).toBe("inherit");
    expect(toReasoningEffortField(undefined)).toBe("inherit");
    expect(fromReasoningEffortField("inherit")).toBeNull();
    expect(fromReasoningEffortField(toReasoningEffortField("high"))).toBe("high");
  });

  it("offers inherit first, then medium and high", () => {
    expect(reasoningEffortItems("Inherit").map((i) => i.value)).toEqual(["inherit", "medium", "high"]);
  });
});

describe("reasoningEffortChip", () => {
  it("shows the task's own value, marks an inherited one, and hides when unset", () => {
    expect(reasoningEffortChip({ reasoningEffort: "medium", effectiveReasoningEffort: "medium" })).toBe("medium");
    expect(reasoningEffortChip({ reasoningEffort: null, effectiveReasoningEffort: "high" })).toBe("high (project)");
    expect(reasoningEffortChip({ reasoningEffort: null, effectiveReasoningEffort: null })).toBeNull();
  });
});
