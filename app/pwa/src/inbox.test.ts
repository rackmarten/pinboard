import { describe, expect, it, vi } from "vitest";
import type { Ask, Task } from "./api.js";
import { createDecideQueue, doneSince, groupByProject, handoffTldr, recentAssumptions, recommendedIndex } from "./inbox.js";

function ask(over: Partial<Ask>): Ask {
  return {
    id: 1,
    taskId: 10,
    threadId: null,
    kind: "question",
    context: null,
    question: "Which one?",
    options: [
      { label: "A", rationale: null, recommended: false },
      { label: "B", rationale: "safer", recommended: true },
    ],
    defaultOption: 1,
    status: "open",
    answerOption: null,
    answerText: null,
    answeredAt: null,
    createdAt: new Date().toISOString(),
    taskTitle: "t",
    taskStatus: "needs_input",
    projectId: 1,
    projectSlug: "p",
    projectName: "P",
    ...over,
  };
}

describe("groupByProject", () => {
  it("groups in first-seen order", () => {
    const groups = groupByProject([
      ask({ id: 1, projectId: 2, projectName: "Two" }),
      ask({ id: 2, projectId: 1, projectName: "One" }),
      ask({ id: 3, projectId: 2, projectName: "Two" }),
    ]);
    expect(groups.map((g) => [g.projectName, g.items.map((a) => a.id)])).toEqual([
      ["Two", [1, 3]],
      ["One", [2]],
    ]);
  });
});

describe("recommendedIndex", () => {
  it("preselects the recommended option", () => {
    expect(recommendedIndex(ask({ defaultOption: 0 }))).toBe(1);
  });
  it("falls back to the default option when none is recommended", () => {
    expect(recommendedIndex({ options: [{ label: "A", rationale: null, recommended: false }], defaultOption: null })).toBeNull();
  });
});

describe("FYI filters", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");
  it("keeps open and accepted assumptions from the last 48h", () => {
    const list = [
      ask({ id: 1, kind: "assumption", createdAt: "2026-09-29T00:00:00Z" }),
      ask({ id: 2, kind: "assumption", status: "accepted", createdAt: "2026-09-28T00:00:00Z" }),
      ask({ id: 3, kind: "assumption", createdAt: "2026-09-27T00:00:00Z" }),
      ask({ id: 4, kind: "assumption", status: "vetoed", createdAt: "2026-09-29T00:00:00Z" }),
      ask({ id: 5, kind: "question", createdAt: "2026-09-29T00:00:00Z" }),
    ];
    expect(recentAssumptions(list, now).map((a) => a.id)).toEqual([1, 2]);
  });
  it("lists done tasks updated after the last visit", () => {
    const tasks = [
      { id: 1, status: "done", updatedAt: "2026-09-29T11:00:00Z" },
      { id: 2, status: "done", updatedAt: "2026-09-29T09:00:00Z" },
      { id: 3, status: "review", updatedAt: "2026-09-29T11:00:00Z" },
    ] as Task[];
    expect(doneSince(tasks, Date.parse("2026-09-29T10:00:00Z")).map((t) => t.id)).toEqual([1]);
  });
});

describe("handoffTldr", () => {
  it("prefers the summary, else the first paragraph of completed", () => {
    expect(handoffTldr({ summary: "short", completed: "long" })).toBe("short");
    expect(handoffTldr({ summary: null, completed: "first\n\nsecond" })).toBe("first");
    expect(handoffTldr(undefined)).toBeNull();
  });
});

describe("createDecideQueue", () => {
  function deps(asks: Ask[]) {
    return {
      getAsks: vi.fn(async () => asks),
      answerAsk: vi.fn(async () => ({})),
      answerRecommended: vi.fn(async () => ({ answered: asks.length })),
      confirm: vi.fn(() => true),
    };
  }

  it("loads only open questions, grouped by project", async () => {
    const d = deps([ask({ id: 1 }), ask({ id: 2, kind: "assumption" }), ask({ id: 3, projectId: 2, projectName: "Q" })]);
    const q = createDecideQueue(d);
    await q.load();
    expect(d.getAsks).toHaveBeenCalledWith(["open"]);
    expect(q.groups.value.map((g) => g.items.map((a) => a.id))).toEqual([[1], [3]]);
  });

  it("removes an answered card right away", async () => {
    const d = deps([ask({ id: 1 }), ask({ id: 2 })]);
    const q = createDecideQueue(d);
    await q.load();
    await q.answer(1, 1, "  go  ");
    expect(d.answerAsk).toHaveBeenCalledWith(1, { option: 1, text: "go" });
    expect(q.questions.value.map((a) => a.id)).toEqual([2]);
  });

  it("keeps the card when answering fails", async () => {
    const d = deps([ask({ id: 1 })]);
    d.answerAsk.mockRejectedValueOnce(new Error("409"));
    const q = createDecideQueue(d);
    await q.load();
    await expect(q.answer(1, 0, "")).rejects.toThrow("409");
    expect(q.questions.value).toHaveLength(1);
  });

  it("Accept all calls the bulk endpoint after one confirm", async () => {
    const d = deps([ask({ id: 1 }), ask({ id: 2 })]);
    const q = createDecideQueue(d);
    await q.load();
    d.getAsks.mockResolvedValueOnce([]);
    expect(await q.acceptAllRecommended()).toBe(2);
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(d.answerRecommended).toHaveBeenCalledTimes(1);
    expect(q.questions.value).toEqual([]);
  });

  it("Accept all does nothing when not confirmed", async () => {
    const d = deps([ask({ id: 1 })]);
    d.confirm.mockReturnValue(false);
    const q = createDecideQueue(d);
    await q.load();
    await q.acceptAllRecommended();
    expect(d.answerRecommended).not.toHaveBeenCalled();
  });
});
