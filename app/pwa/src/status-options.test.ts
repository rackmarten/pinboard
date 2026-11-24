import { describe, expect, it } from "vitest";
import { MANUAL_STATUSES, PHASE_STATUSES, STATUS_PHASES, SYSTEM_STATUSES, TASK_PHASES, TASK_STATUSES, phasesToStatuses, statusPhase } from "./api.js";
import { answerLink, moveComment, statusOptions, statusReadOnly, systemStatusActions } from "./status-options.js";

describe("the phase map", () => {
  it("puts every status in exactly one phase, as the story decided", () => {
    expect(PHASE_STATUSES).toEqual({
      backlog: ["idea", "defined"],
      ready: ["queued"],
      in_progress: ["in_progress"],
      pipeline: ["awaiting_ci", "awaiting_merge", "deploying", "verifying"],
      needs_you: ["needs_input", "review", "rework"],
      done: ["done", "rejected"],
    });
    expect(Object.values(PHASE_STATUSES).flat().sort()).toEqual([...TASK_STATUSES].sort());
    for (const s of TASK_STATUSES) expect(TASK_PHASES).toContain(STATUS_PHASES[s]);
  });
  it("reads an old status name as the one it became", () => {
    expect(statusPhase("executing")).toBe("in_progress");
    expect(statusPhase("awaiting_review")).toBe("needs_you");
  });
  it("turns a phase filter into its statuses", () => {
    expect(phasesToStatuses(["needs_you", "ready"])).toEqual(["queued", "needs_input", "review", "rework"]);
    expect(phasesToStatuses([])).toEqual([]);
  });
});

describe("statusOptions", () => {
  it("offers only the manual statuses for a task", () => {
    expect(MANUAL_STATUSES).toEqual(["idea", "defined", "queued", "rework", "done", "rejected"]);
    for (const s of MANUAL_STATUSES) expect(statusOptions({ status: s, taskType: "implementation" })).toEqual(MANUAL_STATUSES);
  });
  it("splits the statuses into manual and system with nothing left over", () => {
    expect([...MANUAL_STATUSES, ...SYSTEM_STATUSES].sort()).toEqual([...TASK_STATUSES].sort());
    expect(SYSTEM_STATUSES).toEqual(["in_progress", "needs_input", "awaiting_ci", "awaiting_merge", "deploying", "verifying", "review"]);
  });
  it("offers nothing for a task in a system status, which is read-only", () => {
    for (const s of SYSTEM_STATUSES) {
      expect(statusOptions({ status: s, taskType: "bug" })).toEqual([]);
      expect(statusReadOnly({ status: s, taskType: "bug" })).toBe(true);
    }
    expect(statusReadOnly({ status: "rework", taskType: "bug" })).toBe(false);
  });
  it("offers a story its three statuses, never read-only", () => {
    expect(statusOptions({ status: "defined", taskType: "story" })).toEqual(["defined", "done", "rejected"]);
    expect(statusReadOnly({ status: "in_progress", taskType: "story" })).toBe(false);
  });
});

describe("systemStatusActions", () => {
  it("offers Approve in review and Answer in needs_input, Pull out and Reject everywhere", () => {
    expect(systemStatusActions("review")).toEqual(["approve", "pull_out", "reject"]);
    expect(systemStatusActions("needs_input")).toEqual(["answer", "pull_out", "reject"]);
    for (const s of ["in_progress", "awaiting_ci", "awaiting_merge", "deploying", "verifying"]) {
      expect(systemStatusActions(s)).toEqual(["pull_out", "reject"]);
    }
  });
  it("offers nothing for a manual status", () => {
    for (const s of MANUAL_STATUSES) expect(systemStatusActions(s)).toEqual([]);
  });
});

describe("answerLink", () => {
  it("goes to the inbox for an open question, else to the session chat", () => {
    expect(answerLink(1, 7)).toBe("/inbox");
    expect(answerLink(0, 7)).toBe("/chat/7");
    expect(answerLink(0, null)).toBe("/inbox");
  });
});

describe("moveComment", () => {
  it("says where the task came from, with the reason when there is one", () => {
    expect(moveComment("pull_out", "awaiting_ci", " CI is wedged ")).toBe("Pulled out of awaiting_ci into rework: CI is wedged");
    expect(moveComment("reject", "review", "")).toBe("Rejected from review.");
  });
});
