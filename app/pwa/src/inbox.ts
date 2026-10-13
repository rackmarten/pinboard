// the "Needs you" inbox. The pure parts (grouping, what counts as
// recent, the Decide queue's state) live here so they're testable without
// mounting InboxView.
import { computed, ref, type ComputedRef, type Ref } from "vue";
import type { Ask, Handoff, Task } from "./api.js";

export const REVIEW_STATUSES = ["review", "awaiting_review"];
export const FYI_WINDOW_MS = 48 * 3600_000;
export const LAST_VISIT_KEY = "pinboard.inbox.lastVisit";

export interface ProjectGroup<T> {
  projectId: number;
  projectName: string;
  items: T[];
}

// Keeps the order items first appear in, so the newest-first API order
// decides which project comes first too.
export function groupByProject<T extends { projectId: number; projectName: string }>(items: T[]): ProjectGroup<T>[] {
  const groups = new Map<number, ProjectGroup<T>>();
  for (const item of items) {
    let group = groups.get(item.projectId);
    if (!group) {
      group = { projectId: item.projectId, projectName: item.projectName, items: [] };
      groups.set(item.projectId, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

// The option a card starts with selected: the one the agent recommended,
// falling back to the ask's stored default.
export function recommendedIndex(ask: Pick<Ask, "options" | "defaultOption">): number | null {
  const i = ask.options.findIndex((o) => o.recommended);
  return i >= 0 ? i : ask.defaultOption;
}

export function recentAssumptions(asks: Ask[], now: number): Ask[] {
  return asks.filter(
    (a) => a.kind === "assumption" && (a.status === "open" || a.status === "accepted") && now - Date.parse(a.createdAt) <= FYI_WINDOW_MS,
  );
}

export function doneSince(tasks: Task[], since: number): Task[] {
  return tasks.filter((t) => t.status === "done" && Date.parse(t.updatedAt) > since);
}

// The TL;DR a Review card shows: the session's own summary when it wrote
// one, else the first paragraph of what it says it completed.
export function handoffTldr(handoff: Pick<Handoff, "summary" | "completed"> | undefined): string | null {
  if (!handoff) return null;
  if (handoff.summary?.trim()) return handoff.summary.trim();
  return handoff.completed?.trim().split(/\n\s*\n/)[0] ?? null;
}

export interface DecideDeps {
  getAsks: (status: Ask["status"][]) => Promise<Ask[]>;
  answerAsk: (id: number, input: { option?: number | null; text?: string }) => Promise<unknown>;
  answerRecommended: () => Promise<{ answered: number }>;
  confirm: (message: string) => boolean;
}

export interface DecideQueue {
  questions: Ref<Ask[]>;
  groups: ComputedRef<ProjectGroup<Ask>[]>;
  load: () => Promise<void>;
  answer: (id: number, option: number | null, text: string) => Promise<void>;
  acceptAllRecommended: () => Promise<number>;
}

// Open questions, answered one card at a time. An answered card leaves the
// list at once instead of waiting for the next poll.
export function createDecideQueue(deps: DecideDeps): DecideQueue {
  const questions = ref<Ask[]>([]);
  const groups = computed(() => groupByProject(questions.value));

  async function load(): Promise<void> {
    questions.value = (await deps.getAsks(["open"])).filter((a) => a.kind === "question");
  }

  async function answer(id: number, option: number | null, text: string): Promise<void> {
    const trimmed = text.trim();
    await deps.answerAsk(id, { option, ...(trimmed ? { text: trimmed } : {}) });
    questions.value = questions.value.filter((a) => a.id !== id);
  }

  async function acceptAllRecommended(): Promise<number> {
    if (!questions.value.length) return 0;
    if (!deps.confirm(`Answer all ${questions.value.length} open questions with the recommended option?`)) return 0;
    const { answered } = await deps.answerRecommended();
    await load();
    return answered;
  }

  return { questions, groups, load, answer, acceptAllRecommended };
}
