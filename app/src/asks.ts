// structured asks and assumptions. A run records a question (2-4
// options, exactly one recommended) or an assumption it went ahead with; the
// operator answers from the PWA or phone. Answering posts the answer into the
// task's chat thread as a human message, so a session still polling in
// `work task ask` picks it up, and requeues a task parked in needs_input.
//
// Same split as alerts.ts: the rules run against an AskStore, so the tests
// use an in-memory one and dbAskStore is the only part that needs Postgres.
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "./db/client.js";
import { chatMessages, chatThreads, labels, projects, taskAsks, taskLabels, tasks } from "./db/schema.js";
import { recordEvent as recordJournalEvent } from "./journal.js";
import { publishChat } from "./chat-bus.js";
import { applyTransition } from "./pipeline.js";
import { grantState, ROOT_LABEL } from "./root-grants.js";

export const ASK_KINDS = ["question", "assumption"] as const;
export const ASK_STATUSES = ["open", "answered", "vetoed", "accepted"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export interface AskOption {
  label: string;
  rationale: string | null;
  recommended: boolean;
}

export interface AskRow {
  id: number;
  taskId: number;
  threadId: number | null;
  kind: string;
  context: string | null;
  question: string;
  options: AskOption[];
  defaultOption: number | null;
  status: string;
  answerOption: number | null;
  answerText: string | null;
  answeredAt: Date | null;
  createdAt: Date;
}

export type NewAsk = Pick<AskRow, "taskId" | "threadId" | "kind" | "context" | "question" | "options" | "defaultOption">;

export interface Actor {
  actorType: string;
  actorName: string;
}

export class AskError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Pure. Returns the row to insert (minus taskId) or the reason it is refused.
export function validateAsk(body: unknown): { ok: true; value: Omit<NewAsk, "taskId"> } | { ok: false; reason: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind ?? "question";
  if (!ASK_KINDS.includes(kind as AskKind)) return { ok: false, reason: `kind must be one of ${ASK_KINDS.join(", ")}` };
  const question = text(b.question);
  if (!question) return { ok: false, reason: "question is required" };
  const rawOptions = b.options ?? [];
  if (!Array.isArray(rawOptions)) return { ok: false, reason: "options must be an array" };
  const options: AskOption[] = [];
  for (const o of rawOptions) {
    const label = text((o as Record<string, unknown>)?.label);
    if (!label) return { ok: false, reason: "every option needs a label" };
    const r = o as Record<string, unknown>;
    options.push({ label, rationale: text(r.rationale), recommended: r.recommended === true });
  }
  const recommended = options.filter((o) => o.recommended).length;
  if (kind === "question" && options.length > 0) {
    // no options at all is a free-text question (a plain
    // `work task ask <id> <question>`), answered with text.
    if (options.length < 2 || options.length > 4) return { ok: false, reason: "a question needs 0 or 2-4 options" };
    if (recommended !== 1) return { ok: false, reason: "a question needs exactly one recommended option" };
  } else if (kind === "assumption" && (options.length > 4 || recommended > 1)) {
    return { ok: false, reason: "an assumption takes at most 4 options and at most one recommended" };
  }
  let defaultOption: number | null = options.findIndex((o) => o.recommended);
  if (defaultOption < 0) defaultOption = null;
  if (b.defaultOption !== undefined && b.defaultOption !== null) {
    if (!Number.isInteger(b.defaultOption) || (b.defaultOption as number) < 0 || (b.defaultOption as number) >= options.length) {
      return { ok: false, reason: "defaultOption must be an index into options" };
    }
    defaultOption = b.defaultOption as number;
  }
  const threadId = b.threadId === undefined || b.threadId === null ? null : Number(b.threadId);
  if (threadId !== null && !Number.isInteger(threadId)) return { ok: false, reason: "threadId must be an integer" };
  return { ok: true, value: { kind: kind as AskKind, question, context: text(b.context), options, defaultOption, threadId } };
}

// The chat message a session waiting in `work task ask` reads as the reply.
export function answerMessage(ask: AskRow, option: number | null, answerText: string | null): string {
  const lines = [`Answer to ask #${ask.id}: ${ask.question}`];
  if (option !== null) lines.push(`Chosen option ${option + 1}: ${ask.options[option].label}`);
  if (answerText) lines.push(answerText);
  return lines.join("\n\n");
}

export interface AskStore {
  getTask(id: number): Promise<{ id: number; status: string } | null>;
  getAsk(id: number): Promise<AskRow | null>;
  insertAsk(values: NewAsk): Promise<AskRow>;
  updateAsk(id: number, patch: Partial<AskRow>): Promise<AskRow>;
  openQuestions(): Promise<AskRow[]>;
  // The thread the ask names, else the task's most recent one, else null.
  threadFor(ask: AskRow): Promise<number | null>;
  postHumanMessage(threadId: number, body: string): Promise<void>;
  // Moves the task and journals it. Returns the status it actually landed in
  // (a root-access task with an ended grant parks in rework, as in
  // POST /tasks/:id/pipeline).
  moveTask(taskId: number, from: string, to: string, actor: Actor, reason: string): Promise<string>;
  journal(taskId: number, eventType: string, actor: Actor, payload: Record<string, unknown>): Promise<void>;
}

export async function createAsk(store: AskStore, taskId: number, body: unknown, actor: Actor): Promise<AskRow> {
  const task = await store.getTask(taskId);
  if (!task) throw new AskError("not found", 404);
  const valid = validateAsk(body);
  if (!valid.ok) throw new AskError(valid.reason, 400);
  const ask = await store.insertAsk({ ...valid.value, taskId });
  await store.journal(taskId, "ask", actor, { askId: ask.id, kind: ask.kind, question: ask.question, threadId: ask.threadId });
  return ask;
}

export interface AnswerResult {
  ask: AskRow;
  taskStatus: string | null;
}

export async function answerAsk(store: AskStore, id: number, body: unknown, actor: Actor): Promise<AnswerResult> {
  const ask = await store.getAsk(id);
  if (!ask) throw new AskError("not found", 404);
  if (ask.status !== "open") throw new AskError(`ask #${id} is already ${ask.status}`, 409);
  const b = (body ?? {}) as Record<string, unknown>;
  const option = b.option === undefined || b.option === null ? null : b.option;
  if (option !== null && (!Number.isInteger(option) || (option as number) < 0 || (option as number) >= ask.options.length)) {
    throw new AskError("option must be an index into the ask's options", 400);
  }
  const answerText = text(b.text);
  // Accepting an assumption needs neither; a question needs one or the other.
  if (ask.kind === "question" && option === null && !answerText) throw new AskError("option or text is required", 400);

  const updated = await store.updateAsk(id, {
    status: ask.kind === "assumption" ? "accepted" : "answered",
    answerOption: option as number | null,
    answerText,
    answeredAt: new Date(),
  });
  const threadId = await store.threadFor(ask);
  if (threadId !== null) await store.postHumanMessage(threadId, answerMessage(ask, option as number | null, answerText));
  await store.journal(ask.taskId, "ask_answered", actor, { askId: id, option, status: updated.status });

  const task = await store.getTask(ask.taskId);
  let taskStatus = task?.status ?? null;
  if (task && task.status === "needs_input") {
    taskStatus = await store.moveTask(task.id, task.status, "queued", actor, `ask #${id} answered`);
  }
  return { ask: updated, taskStatus };
}

export async function answerRecommended(store: AskStore, actor: Actor): Promise<AnswerResult[]> {
  const results: AnswerResult[] = [];
  for (const ask of await store.openQuestions()) {
    const option = ask.options.findIndex((o) => o.recommended);
    if (ask.kind !== "question" || ask.status !== "open" || option < 0) continue;
    results.push(await answerAsk(store, ask.id, { option }, actor));
  }
  return results;
}

export async function vetoAsk(store: AskStore, id: number, body: unknown, actor: Actor): Promise<AnswerResult> {
  const ask = await store.getAsk(id);
  if (!ask) throw new AskError("not found", 404);
  if (ask.kind !== "assumption") throw new AskError("only an assumption can be vetoed; answer a question instead", 400);
  if (ask.status !== "open" && ask.status !== "accepted") throw new AskError(`ask #${id} is already ${ask.status}`, 409);
  const vetoText = text((body as Record<string, unknown> | undefined)?.text);
  if (!vetoText) throw new AskError("text is required: say why the assumption is wrong", 400);

  const updated = await store.updateAsk(id, { status: "vetoed", answerText: vetoText, answeredAt: new Date() });
  const threadId = await store.threadFor(ask);
  if (threadId !== null) await store.postHumanMessage(threadId, `Assumption #${id} vetoed: ${ask.question}\n\n${vetoText}`);
  await store.journal(ask.taskId, "ask_vetoed", actor, { askId: id });
  const task = await store.getTask(ask.taskId);
  let taskStatus = task?.status ?? null;
  if (task && task.status !== "rework") {
    taskStatus = await store.moveTask(task.id, task.status, "rework", actor, `Assumption vetoed: ${vetoText}`);
  }
  return { ask: updated, taskStatus };
}

function toRow(r: typeof taskAsks.$inferSelect): AskRow {
  return { ...r, options: (r.options ?? []) as AskOption[] };
}

export const dbAskStore: AskStore = {
  async getTask(id) {
    const [row] = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.id, id));
    return row ?? null;
  },
  async getAsk(id) {
    const [row] = await db.select().from(taskAsks).where(eq(taskAsks.id, id));
    return row ? toRow(row) : null;
  },
  async insertAsk(values) {
    const [row] = await db.insert(taskAsks).values(values).returning();
    return toRow(row);
  },
  async updateAsk(id, patch) {
    const [row] = await db.update(taskAsks).set(patch).where(eq(taskAsks.id, id)).returning();
    return toRow(row);
  },
  async openQuestions() {
    const rows = await db
      .select()
      .from(taskAsks)
      .where(and(eq(taskAsks.status, "open"), eq(taskAsks.kind, "question")))
      .orderBy(taskAsks.createdAt);
    return rows.map(toRow);
  },
  async threadFor(ask) {
    if (ask.threadId !== null) return ask.threadId;
    const [thread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.taskId, ask.taskId))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(1);
    return thread?.id ?? null;
  },
  async postHumanMessage(threadId, body) {
    // Same effect as POST /chat/threads/:id/messages with role human.
    const [message] = await db.insert(chatMessages).values({ threadId, role: "human", body }).returning();
    await db.update(chatThreads).set({ awaitingAgent: true, updatedAt: new Date() }).where(eq(chatThreads.id, threadId));
    publishChat({ threadId, event: "human_message", data: message });
  },
  async moveTask(taskId, from, to, actor, reason) {
    let landed = to;
    if (to === "queued") {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      const root = await db
        .select({ id: labels.id })
        .from(taskLabels)
        .innerJoin(labels, eq(taskLabels.labelId, labels.id))
        .where(and(eq(taskLabels.taskId, taskId), eq(labels.name, ROOT_LABEL)));
      if (root.length > 0 && task && !grantState(task, new Date()).active) landed = "rework";
    }
    await applyTransition(taskId, landed, undefined, undefined);
    await this.journal(taskId, "status", actor, { from, to: landed, reason });
    return landed;
  },
  async journal(taskId, eventType, actor, payload) {
    await recordJournalEvent({ taskId, eventType, ...actor, payload });
  },
};

// Open asks, and the ones answered in the last week, for GET /tasks/:id.
export async function asksForTask(taskId: number): Promise<AskRow[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(taskAsks)
    .where(and(eq(taskAsks.taskId, taskId), or(eq(taskAsks.status, "open"), gt(taskAsks.answeredAt, since))))
    .orderBy(taskAsks.createdAt);
  return rows.map(toRow);
}

function actorOf(body: unknown, fallback: Actor): Actor {
  const b = (body ?? {}) as Record<string, unknown>;
  return typeof b.actorType === "string" && typeof b.actorName === "string" ? { actorType: b.actorType, actorName: b.actorName } : fallback;
}

const OPERATOR: Actor = { actorType: "human", actorName: "operator" };
const RUN: Actor = { actorType: "agent", actorName: "runner" };

export async function registerAskRoutes(app: FastifyInstance, store: AskStore = dbAskStore): Promise<void> {
  const wrap = async <T>(reply: { code(c: number): { send(b: unknown): unknown } }, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AskError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  };

  app.post("/tasks/:id/asks", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    return wrap(reply, async () => {
      const ask = await createAsk(store, id, req.body, actorOf(req.body, RUN));
      reply.code(201);
      return ask;
    });
  });

  app.get("/asks", async (req) => {
    const q = req.query as { status?: string; taskId?: string };
    const conditions = [];
    if (q.status) conditions.push(inArray(taskAsks.status, q.status.split(",")));
    if (q.taskId) conditions.push(eq(taskAsks.taskId, Number(q.taskId)));
    const rows = await db
      .select({
        ask: taskAsks,
        taskTitle: tasks.title,
        taskStatus: tasks.status,
        projectId: projects.id,
        projectSlug: projects.slug,
        projectName: projects.name,
      })
      .from(taskAsks)
      .innerJoin(tasks, eq(taskAsks.taskId, tasks.id))
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(taskAsks.createdAt))
      .limit(200);
    return rows.map(({ ask, ...rest }) => ({ ...toRow(ask), ...rest }));
  });

  app.post("/asks/answer-recommended", async (req, reply) =>
    wrap(reply, async () => {
      const results = await answerRecommended(store, actorOf(req.body, OPERATOR));
      return { answered: results.length, results };
    }),
  );

  app.post("/asks/:id/answer", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    return wrap(reply, () => answerAsk(store, id, req.body, actorOf(req.body, OPERATOR)));
  });

  app.post("/asks/:id/veto", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    return wrap(reply, () => vetoAsk(store, id, req.body, actorOf(req.body, OPERATOR)));
  });
}
