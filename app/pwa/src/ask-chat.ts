// "Resolve in chat" - one chat thread seeded with every selected
// open ask (from the inbox's Decide cards, or the single open ask on a task's
// detail page), so the operator can handle asks that need a small hands-on
// action in one session instead of copy-pasting each question. The session
// answers them with `work task answer`, which goes through POST
// /asks/:id/answer and so requeues each task, same as the Answer button.
import type { Ask, ChatThread, Handoff } from "./api.js";
import { handoffTldr } from "./inbox.js";

export type SeedAsk = Pick<Ask, "id" | "taskId" | "taskTitle" | "projectId" | "context" | "question" | "options">;

function askSection(ask: SeedAsk, handoff: Handoff | undefined): string {
  const lines = [`## Ask #${ask.id} on task ${ask.taskId}: ${ask.taskTitle}`];
  const tldr = handoffTldr(handoff);
  if (tldr) lines.push("", `Latest handoff: ${tldr}`);
  if (ask.context?.trim()) lines.push("", `Context: ${ask.context.trim()}`);
  lines.push("", `Question: ${ask.question.trim()}`);
  if (ask.options.length) {
    lines.push("", "Options:");
    ask.options.forEach((o, i) => {
      const rationale = o.rationale?.trim() ? ` - ${o.rationale.trim()}` : "";
      lines.push(`${i + 1}. ${o.label}${o.recommended ? " (recommended)" : ""}${rationale}`);
    });
  }
  return lines.join("\n");
}

// The thread's first message. It is sent as the operator's own message, so
// foreman hands it to the session as the opening prompt.
export function askSeedMessage(asks: SeedAsk[], handoffs: Map<number, Handoff | undefined> = new Map()): string {
  const intro =
    asks.length === 1
      ? "I'd like to settle this open ask with you here rather than from the inbox. It may need a small hands-on check first."
      : `I'd like to settle these ${asks.length} open asks with you here rather than one by one from the inbox. Some may need a small hands-on check first.`;
  const how =
    "Work through them with me. Once we agree on one, record it with `work task answer <askId> <option number>` " +
    "(optionally followed by extra text), or `work task answer <askId> <free text>`. That answers the ask and requeues its task.";
  return [intro, how, ...asks.map((a) => askSection(a, handoffs.get(a.taskId)))].join("\n\n");
}

export function askChatTitle(asks: SeedAsk[]): string {
  if (asks.length === 1) return `Ask #${asks[0].id} on #${asks[0].taskId}: ${asks[0].taskTitle}`.slice(0, 80);
  return `Resolve ${asks.length} asks (${[...new Set(asks.map((a) => `#${a.taskId}`))].join(", ")})`.slice(0, 80);
}

// Scope the thread to the project when every ask shares one, so the session
// starts in that repo's checkout.
export function askChatProjectId(asks: SeedAsk[]): number | undefined {
  const ids = new Set(asks.map((a) => a.projectId));
  return ids.size === 1 ? [...ids][0] : undefined;
}

export interface AskChatDeps {
  getHandoffs: (taskId: number) => Promise<Handoff[]>;
  createChatThread: (title: string, projectId?: number) => Promise<ChatThread>;
  sendChatMessage: (threadId: number, body: string) => Promise<unknown>;
}

// Creates the seeded thread and returns it. The thread has no taskId on
// purpose: a task-scoped thread is the task's own session chat, which is
// where pinboard posts each answer.
export async function startAskChat(deps: AskChatDeps, asks: SeedAsk[]): Promise<ChatThread> {
  if (!asks.length) throw new Error("no asks selected");
  const taskIds = [...new Set(asks.map((a) => a.taskId))];
  const handoffs = new Map<number, Handoff | undefined>();
  await Promise.all(taskIds.map(async (id) => handoffs.set(id, (await deps.getHandoffs(id).catch(() => []))[0])));
  const thread = await deps.createChatThread(askChatTitle(asks), askChatProjectId(asks));
  await deps.sendChatMessage(thread.id, askSeedMessage(asks, handoffs));
  return thread;
}
