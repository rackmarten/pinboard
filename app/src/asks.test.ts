import assert from "node:assert/strict";
import { test } from "node:test";
import { answerAsk, answerRecommended, AskError, createAsk, validateAsk, vetoAsk, type AskRow, type AskStore, type NewAsk } from "./asks.js";
import { deriveNotification } from "./notifications.js";

const agent = { actorType: "agent", actorName: "runner" };
const human = { actorType: "human", actorName: "peter" };

const options = [
  { label: "Postgres", rationale: "already running", recommended: true },
  { label: "SQLite", recommended: false },
];

function memoryStore(taskStatuses: Record<number, string>, threads: Record<number, number> = {}) {
  const asks: AskRow[] = [];
  const messages: { threadId: number; body: string }[] = [];
  const events: { taskId: number; eventType: string; payload: Record<string, unknown> }[] = [];
  const store: AskStore = {
    async getTask(id) {
      return id in taskStatuses ? { id, status: taskStatuses[id] } : null;
    },
    async getAsk(id) {
      return asks.find((a) => a.id === id) ?? null;
    },
    async insertAsk(values: NewAsk) {
      const row: AskRow = { ...values, id: asks.length + 1, status: "open", answerOption: null, answerText: null, answeredAt: null, createdAt: new Date() };
      asks.push(row);
      return row;
    },
    async updateAsk(id, patch) {
      const row = asks.find((a) => a.id === id)!;
      Object.assign(row, patch);
      return row;
    },
    async openQuestions() {
      return asks.filter((a) => a.status === "open" && a.kind === "question");
    },
    async threadFor(ask) {
      return ask.threadId ?? threads[ask.taskId] ?? null;
    },
    async postHumanMessage(threadId, body) {
      messages.push({ threadId, body });
    },
    async moveTask(taskId, from, to, _actor, reason) {
      taskStatuses[taskId] = to;
      events.push({ taskId, eventType: "status", payload: { from, to, reason } });
      return to;
    },
    async journal(taskId, eventType, _actor, payload) {
      events.push({ taskId, eventType, payload });
    },
  };
  return { store, asks, messages, events, taskStatuses };
}

test("a question needs 0 (free text) or 2-4 options", () => {
  assert.equal(validateAsk({ question: "Which db?" }).ok, true);
  const one = validateAsk({ question: "Which db?", options: [options[0]] });
  assert.equal(one.ok, false);
  const five = validateAsk({ question: "Which db?", options: [options[0], ...Array(4).fill({ label: "x" })] });
  assert.equal(five.ok, false);
  assert.equal(validateAsk({ question: "Which db?", options }).ok, true);
});

test("a question needs exactly one recommended option", () => {
  const none = validateAsk({ question: "Which db?", options: [{ label: "a" }, { label: "b" }] });
  assert.match(none.ok ? "" : none.reason, /exactly one recommended/);
  const two = validateAsk({ question: "Which db?", options: [{ label: "a", recommended: true }, { label: "b", recommended: true }] });
  assert.equal(two.ok, false);
});

test("validation fills defaultOption with the recommended index and rejects junk", () => {
  const valid = validateAsk({ question: "Which db?", options: [{ label: "a" }, { label: "b", recommended: true }] });
  assert.equal(valid.ok && valid.value.defaultOption, 1);
  assert.equal(validateAsk({ question: "", options }).ok, false);
  assert.equal(validateAsk({ kind: "wish", question: "x", options }).ok, false);
  assert.equal(validateAsk({ question: "x", options: [{ label: "" }, { label: "b", recommended: true }] }).ok, false);
});

test("an assumption needs no options", () => {
  const valid = validateAsk({ kind: "assumption", question: "Using Postgres, it is already running" });
  assert.equal(valid.ok, true);
});

test("answering requeues a task parked in needs_input and posts into its thread", async () => {
  const { store, messages, events, taskStatuses } = memoryStore({ 7: "needs_input" }, { 7: 42 });
  const ask = await createAsk(store, 7, { question: "Which db?", options }, agent);
  const result = await answerAsk(store, ask.id, { option: 0, text: "keep it simple" }, human);
  assert.equal(result.ask.status, "answered");
  assert.equal(result.ask.answerOption, 0);
  assert.equal(result.taskStatus, "queued");
  assert.equal(taskStatuses[7], "queued");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].threadId, 42);
  assert.match(messages[0].body, /Postgres/);
  assert.match(messages[0].body, /keep it simple/);
  assert.ok(events.some((e) => e.eventType === "status" && e.payload.from === "needs_input" && e.payload.to === "queued"));
});

test("answering a task that is not in needs_input only records the answer", async () => {
  const { store, taskStatuses, events } = memoryStore({ 7: "executing" }, { 7: 42 });
  const ask = await createAsk(store, 7, { question: "Which db?", options }, agent);
  const result = await answerAsk(store, ask.id, { option: 1 }, human);
  assert.equal(result.ask.status, "answered");
  assert.equal(taskStatuses[7], "executing");
  assert.equal(events.filter((e) => e.eventType === "status").length, 0);
});

test("an answer needs an option in range or text, and only once", async () => {
  const { store } = memoryStore({ 7: "executing" });
  const ask = await createAsk(store, 7, { question: "Which db?", options }, agent);
  await assert.rejects(answerAsk(store, ask.id, {}, human), (e: AskError) => e.statusCode === 400);
  await assert.rejects(answerAsk(store, ask.id, { option: 5 }, human), (e: AskError) => e.statusCode === 400);
  await answerAsk(store, ask.id, { text: "neither" }, human);
  await assert.rejects(answerAsk(store, ask.id, { option: 0 }, human), (e: AskError) => e.statusCode === 409);
});

test("answer-recommended answers only open questions", async () => {
  const { store, asks } = memoryStore({ 7: "needs_input", 8: "executing" });
  const q1 = await createAsk(store, 7, { question: "Which db?", options }, agent);
  const q2 = await createAsk(store, 8, { question: "Which port?", options: [{ label: "80" }, { label: "8080", recommended: true }] }, agent);
  const done = await createAsk(store, 8, { question: "Which name?", options }, agent);
  await answerAsk(store, done.id, { option: 1 }, human);
  const assumption = await createAsk(store, 8, { kind: "assumption", question: "Went with ESM" }, agent);

  const results = await answerRecommended(store, human);
  assert.deepEqual(results.map((r) => r.ask.id).sort(), [q1.id, q2.id]);
  assert.equal(asks.find((a) => a.id === q2.id)!.answerOption, 1);
  assert.equal(asks.find((a) => a.id === done.id)!.answerOption, 1);
  assert.equal(asks.find((a) => a.id === assumption.id)!.status, "open");
});

test("vetoing an assumption moves the task to rework with the veto text", async () => {
  const { store, taskStatuses, events } = memoryStore({ 7: "review" });
  const ask = await createAsk(store, 7, { kind: "assumption", question: "Went with SQLite" }, agent);
  await assert.rejects(vetoAsk(store, ask.id, {}, human), (e: AskError) => e.statusCode === 400);
  const result = await vetoAsk(store, ask.id, { text: "must be Postgres" }, human);
  assert.equal(result.ask.status, "vetoed");
  assert.equal(taskStatuses[7], "rework");
  const move = events.find((e) => e.eventType === "status");
  assert.match(String(move?.payload.reason), /must be Postgres/);
});

test("a question cannot be vetoed", async () => {
  const { store } = memoryStore({ 7: "executing" });
  const ask = await createAsk(store, 7, { question: "Which db?", options }, agent);
  await assert.rejects(vetoAsk(store, ask.id, { text: "no" }, human), (e: AskError) => e.statusCode === 400);
});

test("answering an assumption accepts it", async () => {
  const { store } = memoryStore({ 7: "executing" });
  const ask = await createAsk(store, 7, { kind: "assumption", question: "Went with ESM" }, agent);
  const result = await answerAsk(store, ask.id, {}, human);
  assert.equal(result.ask.status, "accepted");
});

test("a new question notifies with the question text as body; an assumption does not", () => {
  const task = { id: 7, title: "Pick a db" };
  const q = deriveNotification({ eventType: "ask", actorType: "agent", actorName: "runner", taskId: 7, payload: { kind: "question", question: "Which db?", threadId: 42 } }, task);
  assert.equal(q?.kind, "question");
  assert.equal(q?.body, "Which db?");
  assert.equal(q?.url, "/chat/42");
  const a = deriveNotification({ eventType: "ask", actorType: "agent", actorName: "runner", taskId: 7, payload: { kind: "assumption", question: "x" } }, task);
  assert.equal(a, null);
});
