import { describe, expect, it } from "vitest";
import { groupTasks, openBlockers, orderChildren, type GroupableTask } from "./story.js";

function t(id: number, extra: Partial<GroupableTask> = {}): GroupableTask {
  return { id, taskType: "implementation", status: "queued", priority: 0, parentTaskId: null, ...extra };
}

describe("groupTasks", () => {
  const story = t(1, { taskType: "story" });
  const a = t(2, { parentTaskId: 1, status: "done" });
  const b = t(3, { parentTaskId: 1 });
  const loose = t(4);
  const all = [loose, story, a, b];

  it("nests children under their story with done/total progress", () => {
    const rows = groupTasks([loose, story, a, b], all);
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([[4, 0], [1, 0], [2, 1], [3, 1]]);
    expect(rows[1].progress).toEqual({ done: 1, total: 2 });
    expect(rows[1].childCount).toBe(2);
    expect(rows[0].progress).toBeUndefined();
  });

  it("keeps a filtered-out story visible when a child matches", () => {
    const rows = groupTasks([loose, b], all);
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([[4, 0], [1, 0], [3, 1]]);
    expect(rows[1].progress).toEqual({ done: 1, total: 2 });
    expect(rows[1].childCount).toBe(1);
  });

  it("hides children of a collapsed story", () => {
    const rows = groupTasks([story, a, b], all, new Set([1]));
    expect(rows.map((r) => r.task.id)).toEqual([1]);
  });

  it("leaves children of a non-story parent at top level", () => {
    const parent = t(10);
    const child = t(11, { parentTaskId: 10 });
    const rows = groupTasks([parent, child], [parent, child]);
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([[10, 0], [11, 0]]);
  });

  it("shows an empty story with 0/0", () => {
    const rows = groupTasks([t(20, { taskType: "story" })], [t(20, { taskType: "story" })]);
    expect(rows[0].progress).toEqual({ done: 0, total: 0 });
  });
});

describe("orderChildren", () => {
  it("orders by priority when there are no dependencies", () => {
    const kids = [t(1, { priority: 1 }), t(2, { priority: 5 }), t(3, { priority: 1 })];
    expect(orderChildren(kids, new Map()).map((c) => c.id)).toEqual([2, 1, 3]);
  });

  it("puts dependencies first, then priority", () => {
    // 3 depends on 2, 2 depends on 1; 4 is free with the highest priority.
    const kids = [t(1), t(2, { priority: 9 }), t(3, { priority: 9 }), t(4, { priority: 10 })];
    const deps = new Map([[2, [1]], [3, [2]]]);
    expect(orderChildren(kids, deps).map((c) => c.id)).toEqual([4, 1, 2, 3]);
  });

  it("ignores dependencies outside the siblings", () => {
    const kids = [t(1), t(2, { priority: 3 })];
    expect(orderChildren(kids, new Map([[2, [99]]])).map((c) => c.id)).toEqual([2, 1]);
  });

  it("falls back to priority order on a cycle instead of hanging", () => {
    const kids = [t(1, { priority: 1 }), t(2, { priority: 2 }), t(3, { priority: 3 }), t(4)];
    const deps = new Map([[1, [2]], [2, [1]], [3, [2]]]);
    expect(orderChildren(kids, deps).map((c) => c.id)).toEqual([4, 3, 2, 1]);
  });
});

describe("openBlockers", () => {
  it("returns only known targets that are not satisfied", () => {
    const satisfied: Record<number, boolean> = { 1: true, 2: false, 3: true };
    expect(openBlockers([1, 2, 3, 4], (id) => satisfied[id])).toEqual([2]);
  });
});
