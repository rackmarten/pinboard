import { describe, expect, it } from "vitest";
import type { TaskCount } from "./api.js";
import { phaseGroups, visibleInList } from "./task-filters.js";

describe("visibleInList", () => {
  it("hides done and rejected by default", () => {
    expect(visibleInList("queued", {})).toBe(true);
    expect(visibleInList("done", {})).toBe(false);
    expect(visibleInList("rejected", {})).toBe(false);
  });
  it("shows done in the Done phase, but rejected only when the exact status names it", () => {
    expect(visibleInList("done", { phase: ["done"] })).toBe(true);
    expect(visibleInList("rejected", { phase: ["done"] })).toBe(false);
    expect(visibleInList("rejected", { phase: ["done"], status: ["rejected"] })).toBe(true);
    expect(visibleInList("done", { status: ["done"] })).toBe(true);
  });
});

describe("phaseGroups", () => {
  const counts: TaskCount[] = [
    { status: "review", phase: "needs_you", projectId: 1, count: 2 },
    { status: "rework", phase: "needs_you", projectId: 2, count: 1 },
    { status: "needs_input", phase: "needs_you", projectId: 1, count: 1 },
    { status: "awaiting_ci", phase: "pipeline", projectId: 2, count: 1 },
    { status: "idea", phase: "backlog", projectId: 1, count: 4 },
    { status: "done", phase: "done", projectId: 1, count: 9 },
  ];
  it("sums per phase in phase order, with statuses and projects busiest first", () => {
    expect(phaseGroups(counts, ["done"])).toEqual([
      { phase: "backlog", count: 4, statuses: [{ status: "idea", count: 4 }], byProject: [{ projectId: 1, count: 4 }] },
      { phase: "pipeline", count: 1, statuses: [{ status: "awaiting_ci", count: 1 }], byProject: [{ projectId: 2, count: 1 }] },
      {
        phase: "needs_you",
        count: 4,
        statuses: [
          { status: "review", count: 2 },
          { status: "rework", count: 1 },
          { status: "needs_input", count: 1 },
        ],
        byProject: [
          { projectId: 1, count: 3 },
          { projectId: 2, count: 1 },
        ],
      },
    ]);
  });
  it("keeps the done phase unless skipped", () => {
    expect(phaseGroups(counts).map((g) => g.phase)).toEqual(["backlog", "pipeline", "needs_you", "done"]);
  });
});
