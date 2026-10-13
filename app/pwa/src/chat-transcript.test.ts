// The fold is where a producer/consumer disagreement shows up, and a past task
// learned that such a disagreement fails silently on both sides - no error,
// no log, just a row that never renders. These exercise it against the exact
// payloads foreman's chat-session.ts and chat-permissions.ts write.
import { describe, expect, test } from "vitest";
import { foldChatEvents, legacyMessages, thinkingLabel, type ChatEvent, type ThinkingItem } from "./chat-transcript.js";

let nextId = 0;

function ev(kind: string, payload: Record<string, unknown>, turn = 1): ChatEvent {
  nextId += 1;
  return {
    id: nextId,
    threadId: 1,
    turn,
    seq: nextId,
    kind,
    payload,
    createdAt: new Date(1_700_000_000_000 + nextId * 1000).toISOString(),
  };
}

const QUESTIONS = [
  {
    question: "Which breakpoint should desktop start at?",
    header: "Breakpoint",
    multiSelect: false,
    options: [
      { label: "lg (1280px+)", description: "Laptops stay mobile-style.", preview: "<lg>" },
      { label: "md (960px+)", description: "Tablets too." },
    ],
  },
];

describe("thinking rows", () => {
  test("a redacted-thinking run is one row that counts up, not one row per report", () => {
    const { turns } = foldChatEvents([
      ev("turn_start", { text: "hi" }),
      ev("thinking", { estimatedTokens: 200 }),
      ev("thinking", { estimatedTokens: 1400 }),
      ev("thinking", { estimatedTokens: 3400 }),
    ]);
    const thinking = turns[0].items.filter((i) => i.type === "thinking") as ThinkingItem[];
    expect(thinking).toHaveLength(1);
    expect(thinking[0].estimatedTokens).toBe(3400);
    expect(thinkingLabel(thinking[0])).toBe("Thinking… ~3.4k tokens");
  });

  test("the blank events recorded before the fix render as nothing at all", () => {
    const { turns } = foldChatEvents([ev("turn_start", { text: "hi" }), ev("thinking", { text: "" })]);
    expect(turns[0].items).toEqual([]);
  });

  test("real thinking text still merges across batches and stays expandable", () => {
    const { turns } = foldChatEvents([
      ev("turn_start", { text: "hi" }),
      ev("thinking", { text: "first " }),
      ev("thinking", { text: "second" }),
    ]);
    const thinking = turns[0].items.filter((i) => i.type === "thinking") as ThinkingItem[];
    expect(thinking).toHaveLength(1);
    expect(thinking[0].text).toBe("first second");
    expect(thinkingLabel(thinking[0])).toBe("Thinking");
  });

  test("progress and text are separate rows - a progress row has nothing to append to", () => {
    const { turns } = foldChatEvents([
      ev("turn_start", { text: "hi" }),
      ev("thinking", { estimatedTokens: 500 }),
      ev("thinking", { text: "now out loud" }),
    ]);
    const thinking = turns[0].items.filter((i) => i.type === "thinking") as ThinkingItem[];
    expect(thinking.map((t) => t.text)).toEqual(["", "now out loud"]);
  });
});

describe("question cards", () => {
  test("a question becomes an answerable card docked as the pending one", () => {
    const { turns, pendingQuestion } = foldChatEvents([
      ev("turn_start", { text: "plan the work" }),
      ev("question", { requestId: "q1", toolUseId: "toolu_1", questions: QUESTIONS, turn: 1, expiresAt: "2026-09-22T10:00:00Z" }),
    ]);
    expect(turns[0].items).toHaveLength(1);
    expect(pendingQuestion?.request.requestId).toBe("q1");
    expect(pendingQuestion?.request.questions[0].options[0].preview).toBe("<lg>");
    expect(pendingQuestion?.request.questions[0].multiSelect).toBe(false);
  });

  test("an answer resolves the card and clears the dock", () => {
    const answers = { "Which breakpoint should desktop start at?": "lg (1280px+)" };
    const { turns, pendingQuestion } = foldChatEvents([
      ev("turn_start", { text: "plan the work" }),
      ev("question", { requestId: "q1", questions: QUESTIONS }),
      ev("question_answer", { requestId: "q1", answers, answered: true }),
    ]);
    const item = turns[0].items[0];
    expect(item.type).toBe("question");
    if (item.type === "question") expect(item.answer).toEqual({ answered: true, answers, reason: null });
    expect(pendingQuestion).toBeNull();
  });

  test("a timeout resolves the card without claiming it was answered", () => {
    const { turns, pendingQuestion } = foldChatEvents([
      ev("turn_start", { text: "plan the work" }),
      ev("question", { requestId: "q1", questions: QUESTIONS }),
      ev("question_answer", { requestId: "q1", answered: false, reason: "no operator reply within 1800s" }),
    ]);
    const item = turns[0].items[0];
    if (item.type === "question") {
      expect(item.answer?.answered).toBe(false);
      expect(item.answer?.reason).toContain("no operator reply");
    }
    expect(pendingQuestion).toBeNull();
  });

  test("both producers' answers merge rather than overwriting each other", () => {
    // foreman emits {answered, answers}; pinboard's own route inserts
    // {requestId, answers, annotations, answered} - whichever lands first
    // resolves the card and the second only fills in what it lacked.
    const answers = { "Which breakpoint should desktop start at?": "lg (1280px+)" };
    const { turns } = foldChatEvents([
      ev("turn_start", { text: "plan" }),
      ev("question", { requestId: "q1", questions: QUESTIONS }),
      ev("question_answer", { requestId: "q1", answers, answered: true }, 0),
      ev("question_answer", { requestId: "q1", answered: true }),
    ]);
    const item = turns[0].items[0];
    if (item.type === "question") expect(item.answer?.answers).toEqual(answers);
  });

  test("a question with no answerable options is never docked", () => {
    // foreman drops these before emitting, but a card with nothing to tap
    // would park the session until its deadline, so the dock refuses it too.
    const { pendingQuestion } = foldChatEvents([
      ev("turn_start", { text: "plan" }),
      ev("question", { requestId: "q1", questions: [{ question: "Pick?", options: [] }] }),
    ]);
    expect(pendingQuestion).toBeNull();
  });

  test("a question in a finished turn is history, not something to answer", () => {
    const { pendingQuestion } = foldChatEvents([
      ev("turn_start", { text: "one" }, 1),
      ev("question", { requestId: "q1", questions: QUESTIONS }, 1),
      ev("turn_start", { text: "two" }, 2),
    ]);
    expect(pendingQuestion).toBeNull();
  });
});

describe("a subagent turn's cost and end", () => {
  test("the last cost tick wins and the turn only ends on turn_end", () => {
    const { turns } = foldChatEvents([
      ev("turn_start", { text: "plan the work" }),
      ev("cost", { costUsd: 0.11, durationMs: 24475, numTurns: 2, interim: true }),
      ev("tool_start", { toolUseId: "t1", name: "Read", input: { file_path: "/x" } }),
      ev("cost", { costUsd: 0.4, durationMs: 772253, numTurns: 2 }),
      ev("turn_end", { isError: false }),
    ]);
    expect(turns[0].costUsd).toBe(0.4);
    expect(turns[0].durationMs).toBe(772253);
    expect(turns[0].running).toBe(false);
  });

  test("an interim cost alone leaves the turn running", () => {
    const { turns, running } = foldChatEvents([
      ev("turn_start", { text: "plan the work" }),
      ev("cost", { costUsd: 0.11, durationMs: 24475, numTurns: 2, interim: true }),
    ]);
    expect(turns[0].running).toBe(true);
    expect(running).toBe(true);
  });
});

describe("legacyMessages", () => {
  const msg = (role: string, body: string, ms: number) => ({ role, body, createdAt: new Date(ms).toISOString() });

  test("drops the prompt that opened the first held turn", () => {
    const start = ev("turn_start", { text: "hello" }, 2);
    const at = Date.parse(start.createdAt);
    const older = msg("human", "earlier", at - 60_000);
    const opener = msg("human", "hello", at - 300);
    const reply = msg("agent", "hi", at + 5_000);
    expect(legacyMessages([older, opener, reply], [start])).toEqual([older]);
  });

  test("keeps everything older when the window starts mid-turn", () => {
    const text = ev("text_delta", { text: "partial" }, 5);
    const at = Date.parse(text.createdAt);
    const prompt = msg("human", "question", at - 10_000);
    expect(legacyMessages([prompt], [text])).toEqual([prompt]);
  });

  test("returns all messages when there are no events", () => {
    const only = msg("human", "pre-148", 0);
    expect(legacyMessages([only], [])).toEqual([only]);
  });
});
