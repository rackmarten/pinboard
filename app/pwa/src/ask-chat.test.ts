import { describe, expect, it } from "vitest";
import type { ChatThread, Handoff } from "./api.js";
import { askChatProjectId, askChatTitle, askSeedMessage, startAskChat, type SeedAsk } from "./ask-chat.js";

function ask(overrides: Partial<SeedAsk> = {}): SeedAsk {
  return {
    id: 11,
    taskId: 506,
    taskTitle: "Resolve asks in chat",
    projectId: 1,
    context: "The runner found two ports in use.",
    question: "Which port should the API use?",
    options: [
      { label: "8095", rationale: "matches the docs", recommended: true },
      { label: "8096", rationale: null, recommended: false },
    ],
    ...overrides,
  };
}

function handoff(summary: string): Handoff {
  return { id: 1, taskId: 506, completed: null, changed: null, verified: null, problems: null, discovered: null, next: null, summary, costUsd: null, createdAt: "" };
}

describe("askSeedMessage", () => {
  it("lists one ask with its handoff TL;DR, context, question and options", () => {
    const body = askSeedMessage([ask()], new Map([[506, handoff("Built the API, port unclear.")]]));
    expect(body).toContain("settle this open ask");
    expect(body).toContain("## Ask #11 on task 506: Resolve asks in chat");
    expect(body).toContain("Latest handoff: Built the API, port unclear.");
    expect(body).toContain("Context: The runner found two ports in use.");
    expect(body).toContain("Question: Which port should the API use?");
    expect(body).toContain("1. 8095 (recommended) - matches the docs");
    expect(body).toMatch(/^2\. 8096$/m);
    expect(body).not.toContain("2. 8096 (recommended)");
    expect(body).toContain("work task answer <askId>");
  });

  it("lists every ask for N asks and skips what an ask lacks", () => {
    const body = askSeedMessage([ask(), ask({ id: 12, taskId: 507, taskTitle: "Other", context: null, options: [] })]);
    expect(body).toContain("these 2 open asks");
    expect(body).toContain("## Ask #11 on task 506");
    expect(body).toContain("## Ask #12 on task 507: Other");
    expect(body.split("Context:").length).toBe(2);
    expect(body).not.toContain("Latest handoff");
    expect(body.indexOf("Ask #11")).toBeLessThan(body.indexOf("Ask #12"));
  });
});

describe("askChatTitle / askChatProjectId", () => {
  it("titles and scopes a single ask by its task", () => {
    expect(askChatTitle([ask()])).toBe("Ask #11 on #506: Resolve asks in chat");
    expect(askChatProjectId([ask()])).toBe(1);
  });

  it("drops the project when asks span several", () => {
    const asks = [ask(), ask({ id: 12, taskId: 507, projectId: 2 })];
    expect(askChatTitle(asks)).toBe("Resolve 2 asks (#506, #507)");
    expect(askChatProjectId(asks)).toBeUndefined();
  });
});

describe("startAskChat", () => {
  it("creates one thread and seeds it with the asks and each task's latest handoff", async () => {
    const calls: string[] = [];
    let sent = "";
    const thread = await startAskChat(
      {
        getHandoffs: async (taskId) => {
          calls.push(`handoffs ${taskId}`);
          return taskId === 506 ? [handoff("newest"), handoff("older")] : [];
        },
        createChatThread: async (title, projectId) => {
          calls.push(`create ${title} ${projectId}`);
          return { id: 42 } as ChatThread;
        },
        sendChatMessage: async (threadId, body) => {
          calls.push(`send ${threadId}`);
          sent = body;
        },
      },
      [ask(), ask({ id: 12 })],
    );
    expect(thread.id).toBe(42);
    expect(calls).toEqual(["handoffs 506", "create Resolve 2 asks (#506) 1", "send 42"]);
    expect(sent).toContain("Latest handoff: newest");
    expect(sent).toContain("## Ask #12 on task 506");
  });

  it("refuses an empty selection", async () => {
    const noop = async () => {
      throw new Error("should not be called");
    };
    await expect(startAskChat({ getHandoffs: noop, createChatThread: noop, sendChatMessage: noop }, [])).rejects.toThrow(/no asks/);
  });
});
