import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ChatEventError,
  EVENTS_PER_THREAD_CAP,
  MAX_EVENTS_PER_BATCH,
  MAX_PAYLOAD_BYTES,
  activeRulesForTurn,
  formatSseFrame,
  isForemanStreamEvent,
  normalizeEventBatch,
  normalizePermissionRule,
  normalizePermissionDecision,
  normalizeQuestionAnswer,
  toPermissionUpdates,
  truncatePayload,
} from "./chat-events.js";

test("a batch is normalized with foreman's own turn and seq preserved", () => {
  const events = normalizeEventBatch({
    events: [
      { kind: "turn_start", turn: 3, seq: 0 },
      { kind: "text_delta", payload: { text: "hi" }, turn: 3, seq: 1 },
    ],
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].turn, 3);
  assert.equal(events[1].seq, 1);
  assert.deepEqual(events[1].payload, { text: "hi" });
});

test("seq falls back to batch position so send order survives a caller that omits it", () => {
  const events = normalizeEventBatch({ events: [{ kind: "thinking" }, { kind: "text_delta" }, { kind: "turn_end" }] });
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2],
  );
  // turn defaults to 0 rather than erroring - a one-off error event doesn't
  // have to invent a turn number.
  assert.deepEqual(new Set(events.map((e) => e.turn)), new Set([0]));
});

test("a bare array is accepted as well as {events: [...]}", () => {
  assert.equal(normalizeEventBatch([{ kind: "cost", payload: { costUsd: 0.12 } }]).length, 1);
});

test("an unknown kind is rejected rather than stored", () => {
  assert.throws(() => normalizeEventBatch({ events: [{ kind: "tool_started" }] }), ChatEventError);
});

test("an empty or oversized batch is rejected", () => {
  assert.throws(() => normalizeEventBatch({ events: [] }), ChatEventError);
  const tooMany = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ({ kind: "text_delta" }));
  assert.throws(() => normalizeEventBatch({ events: tooMany }), ChatEventError);
});

test("a negative or fractional turn/seq is rejected", () => {
  assert.throws(() => normalizeEventBatch({ events: [{ kind: "thinking", turn: -1 }] }), ChatEventError);
  assert.throws(() => normalizeEventBatch({ events: [{ kind: "thinking", seq: 1.5 }] }), ChatEventError);
});

test("a missing payload is stored as null, not undefined", () => {
  assert.equal(normalizeEventBatch({ events: [{ kind: "turn_end" }] })[0].payload, null);
});

test("an oversized string payload is truncated, not dropped", () => {
  const huge = "x".repeat(MAX_PAYLOAD_BYTES * 2);
  const out = truncatePayload(huge) as string;
  assert.ok(out.length < huge.length);
  assert.ok(out.endsWith("[truncated by pinboard]"));
});

test("an oversized object payload keeps its shape and is marked truncated", () => {
  const out = truncatePayload({ tool: "Read", result: "y".repeat(MAX_PAYLOAD_BYTES * 2) }) as Record<string, unknown>;
  assert.equal(out.truncated, true);
  assert.equal(out.tool, "Read");
  assert.ok(String(out.result).endsWith("[truncated by pinboard]"));
});

test("a small payload passes through untouched", () => {
  const payload = { tool: "Bash", command: "ls" };
  assert.equal(truncatePayload(payload), payload);
});

test("the per-thread retention cap is a real bound, not advisory", () => {
  assert.ok(EVENTS_PER_THREAD_CAP > MAX_EVENTS_PER_BATCH, "a single legal batch must never overflow the cap on its own");
});

test("a permission rule is normalized into the SDK's own shape", () => {
  const rule = normalizePermissionRule({ toolName: "Bash", ruleContent: "git status:*", behavior: "allow" });
  assert.deepEqual(rule, { toolName: "Bash", ruleContent: "git status:*", behavior: "allow", scope: "thread", turn: null });
});

test("a rule without ruleContent means the whole tool", () => {
  assert.equal(normalizePermissionRule({ toolName: "Read", behavior: "allow" }).ruleContent, null);
});

test("an unknown behavior or scope is rejected", () => {
  assert.throws(() => normalizePermissionRule({ toolName: "Bash", behavior: "maybe" }), ChatEventError);
  assert.throws(() => normalizePermissionRule({ toolName: "Bash", behavior: "allow", scope: "forever" }), ChatEventError);
});

test("a turn-scoped rule must say which turn, or it would apply forever", () => {
  assert.throws(() => normalizePermissionRule({ toolName: "Bash", behavior: "allow", scope: "turn" }), ChatEventError);
  assert.equal(normalizePermissionRule({ toolName: "Bash", behavior: "allow", scope: "turn", turn: 4 }).turn, 4);
});

test("a missing toolName is rejected", () => {
  assert.throws(() => normalizePermissionRule({ behavior: "allow" }), ChatEventError);
  assert.throws(() => normalizePermissionRule({ toolName: "   ", behavior: "allow" }), ChatEventError);
});

const rule = (over: Partial<Parameters<typeof activeRulesForTurn>[0][number]> = {}) => ({
  toolName: "Bash",
  ruleContent: null,
  behavior: "allow",
  scope: "thread",
  turn: null,
  revokedAt: null,
  ...over,
});

test("thread-scoped rules apply in every turn, including with no turn in flight", () => {
  assert.equal(activeRulesForTurn([rule()], 7).length, 1);
  assert.equal(activeRulesForTurn([rule()], null).length, 1);
});

test("a turn-scoped rule applies only inside the turn it was granted in", () => {
  const rules = [rule({ scope: "turn", turn: 4 })];
  assert.equal(activeRulesForTurn(rules, 4).length, 1);
  assert.equal(activeRulesForTurn(rules, 5).length, 0);
  assert.equal(activeRulesForTurn(rules, null).length, 0);
});

test("a revoked rule never applies, whatever its scope", () => {
  assert.equal(activeRulesForTurn([rule({ revokedAt: new Date() })], 1).length, 0);
  assert.equal(activeRulesForTurn([rule({ scope: "turn", turn: 1, revokedAt: new Date() })], 1).length, 0);
});

test("rules translate to Agent SDK permission updates grouped by behavior", () => {
  const updates = toPermissionUpdates([
    rule({ ruleContent: "git status:*" }),
    rule({ toolName: "Read" }),
    rule({ toolName: "Bash", ruleContent: "rm:*", behavior: "deny" }),
  ]);
  assert.equal(updates.length, 2);
  const allow = updates.find((u) => u.behavior === "allow");
  assert.ok(allow);
  assert.equal(allow.type, "addRules");
  assert.equal(allow.destination, "session");
  assert.deepEqual(allow.rules, [{ toolName: "Bash", ruleContent: "git status:*" }, { toolName: "Read" }]);
  const deny = updates.find((u) => u.behavior === "deny");
  assert.deepEqual(deny?.rules, [{ toolName: "Bash", ruleContent: "rm:*" }]);
});

test("an SSE frame is well formed, with every data line prefixed and a blank terminator", () => {
  const frame = formatSseFrame("human_message", { threadId: 3, body: "hi" }, 42);
  assert.equal(frame, 'id: 42\nevent: human_message\ndata: {"threadId":3,"body":"hi"}\n\n');
});

test("an SSE frame without an id omits the id line entirely", () => {
  assert.ok(formatSseFrame("interrupt", { threadId: 1 }).startsWith("event: interrupt\n"));
});

test("a permission decision needs a requestId and a real behavior", () => {
  assert.throws(() => normalizePermissionDecision({ behavior: "allow" }), ChatEventError);
  assert.throws(() => normalizePermissionDecision({ requestId: "r1", behavior: "maybe" }), ChatEventError);
  // "ask" is a rule behavior, not something an operator can answer with.
  assert.throws(() => normalizePermissionDecision({ requestId: "r1", behavior: "ask" }), ChatEventError);
});

test("a decision carries the SDK's permission updates through untouched", () => {
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" }];
  const decision = normalizePermissionDecision({ requestId: "r1", behavior: "allow", updatedPermissions: suggestions });
  // Passed through by reference, not rebuilt: the SDK owns this shape, and
  // validating its insides here would reject a legitimate new update type.
  assert.deepEqual(decision.updatedPermissions, suggestions);
});

test("a decision without updates or a message normalizes those to null", () => {
  const decision = normalizePermissionDecision({ requestId: "r1", behavior: "deny" });
  assert.equal(decision.updatedPermissions, null);
  assert.equal(decision.message, null);
});

test("a non-array updatedPermissions is rejected rather than stored", () => {
  assert.throws(() => normalizePermissionDecision({ requestId: "r1", behavior: "allow", updatedPermissions: {} }), ChatEventError);
});

// Regression, found live 2026-09-17: a denial was posted, stored and
// published, and the session stayed parked - because the foreman stream's
// allowlist did not include the event it was blocked on. Nothing logged a
// reason on either side; the turn simply sat there.
test("foreman's stream carries every event a live session needs to make progress", () => {
  for (const event of ["human_message", "permission_decision", "interrupt"]) {
    assert.ok(isForemanStreamEvent(event), `${event} must reach foreman or a session can stall`);
  }
});

test("foreman's stream does not echo a session's own transcript back at it", () => {
  assert.equal(isForemanStreamEvent("chat_event"), false);
});

// --- question answers -------------------------------------------

test("normalizeQuestionAnswer keeps the picks and drops empty ones", () => {
  const answer = normalizeQuestionAnswer({
    requestId: "q1",
    answers: { "Which breakpoint?": "lg (1280px+)", "Which scope?": "" },
  });
  assert.deepEqual(answer, {
    requestId: "q1",
    answers: { "Which breakpoint?": "lg (1280px+)" },
    annotations: null,
  });
});

test("normalizeQuestionAnswer joins nothing for the caller - a multi-select arrives pre-joined", () => {
  const answer = normalizeQuestionAnswer({ requestId: "q1", answers: { "Which widgets?": "Relations, Dashboard" } });
  assert.equal(answer.answers["Which widgets?"], "Relations, Dashboard");
});

test("normalizeQuestionAnswer keeps usable annotations and drops the rest", () => {
  const answer = normalizeQuestionAnswer({
    requestId: "q1",
    answers: { q: "a" },
    annotations: { q: { notes: "laptops stay narrow", preview: "" }, other: { notes: 7 }, bad: "nope" },
  });
  assert.deepEqual(answer.annotations, { q: { notes: "laptops stay narrow" } });
});

test("normalizeQuestionAnswer rejects what would reach the model as nonsense", () => {
  assert.throws(() => normalizeQuestionAnswer({ answers: { q: "a" } }), /requestId is required/);
  assert.throws(() => normalizeQuestionAnswer({ requestId: "q1" }), /answers must be an object/);
  assert.throws(() => normalizeQuestionAnswer({ requestId: "q1", answers: [] }), /answers must be an object/);
  assert.throws(() => normalizeQuestionAnswer({ requestId: "q1", answers: { q: 3 } }), /must be a string/);
  // An empty map would stop the session waiting while handing the tool the
  // same nothing a missed question produces.
  assert.throws(() => normalizeQuestionAnswer({ requestId: "q1", answers: {} }), /at least one answer/);
  assert.throws(() => normalizeQuestionAnswer({ requestId: "q1", answers: { q: "" } }), /at least one answer/);
});

test("question and question_answer are accepted event kinds", () => {
  const events = normalizeEventBatch([
    { kind: "question", payload: { requestId: "q1", questions: [] }, turn: 3 },
    { kind: "question_answer", payload: { requestId: "q1", answered: true }, turn: 3 },
  ]);
  assert.deepEqual(events.map((e) => e.kind), ["question", "question_answer"]);
});

test("foreman's stream carries question_answer - a session is parked on it", () => {
  assert.equal(isForemanStreamEvent("question_answer"), true);
  // Its own transcript rows are still excluded: foreman wrote them.
  assert.equal(isForemanStreamEvent("question"), false);
});
