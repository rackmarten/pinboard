// GET /now: the stories worth looking at right now, and POST /session-links,
// which records which interactive Claude Code sessions touched which tasks.
// The assembly (buildNowStories) is pure so it can be tested without a
// database; loadNow gathers its inputs in a handful of queries.
import { and, eq, inArray, notInArray, or, sql as sqlRaw } from "drizzle-orm";
import { db } from "./db/client.js";
import { projects, sessionLinks, taskAsks, taskEvents, taskRelations, tasks, usageEvents } from "./db/schema.js";
import { parentMap } from "./task-model.js";

// A story counts as active when a child is in one of these (the queue, a
// run, the post-PR pipeline, review, or parked on a question) ...
export const ACTIVE_CHILD_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "executing",
  "needs_input",
  "handoff",
  "awaiting_ci",
  "awaiting_merge",
  "awaiting_review",
  "deploying",
  "verifying",
  "review",
  "rework",
]);
// ... or when the story or a child saw activity this recently.
export const NOW_ACTIVITY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// Sessions not seen for this long are left out of finishedSessions, so the
// scan stays bounded as the link table grows.
export const FINISHED_SESSIONS_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["executing"]);
const REVIEW_STATUSES: ReadonlySet<string> = new Set(["review", "awaiting_review"]);
const HUMAN_WAITING_STATUSES: ReadonlySet<string> = new Set(["queued", "defined"]);
const STORY_CLOSED_STATUSES = ["done", "rejected"];
const MAX_SESSIONS = 3;

export interface NowTask {
  id: number;
  projectId: number;
  title: string;
  status: string;
  executorMode: string;
  priority: number;
  createdAt: Date;
}

export interface NowAsk {
  id: number;
  taskId: number;
  question: string;
  createdAt: Date;
}

export interface NowSessionLink {
  sessionId: string;
  taskId: number;
  cwd: string | null;
  lastSeenAt: Date;
}

export interface NowProject {
  id: number;
  slug: string;
  name: string;
}

export type NowWaiting =
  | { kind: "human"; taskId: number; title: string }
  | { kind: "ask"; taskId: number; title: string; askId: number; question: string }
  | { kind: "review"; taskId: number; title: string };

export interface NowStory {
  id: number;
  title: string;
  status: string;
  project: NowProject;
  progress: { done: number; total: number };
  running: { id: number; title: string; status: string }[];
  waiting: NowWaiting[];
  next: { id: number; title: string } | null;
  sessions: { sessionId: string; cwd: string | null; lastSeenAt: string }[];
  interactiveCostUsd: number;
  lastActivityAt: string | null;
}

export interface NowInputs {
  now: Date;
  stories: readonly NowTask[];
  // story id -> its children
  children: ReadonlyMap<number, readonly NowTask[]>;
  projects: ReadonlyMap<number, NowProject>;
  // task id -> its latest journal event
  lastEventAt: ReadonlyMap<number, Date>;
  // open asks of kind question, any task
  openQuestions: readonly NowAsk[];
  sessionLinks: readonly NowSessionLink[];
  // session id -> summed interactive spend
  interactiveCostBySession: ReadonlyMap<string, number>;
}

// The dispatcher's order (plan.ts's rankRunnableTasks): priority desc, then
// oldest first. Tasks have no explicit position within a story.
function byQueueOrder(a: NowTask, b: NowTask): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  return t !== 0 ? t : a.id - b.id;
}

function maxDate(dates: Iterable<Date | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}

export function buildNowStories(input: NowInputs): NowStory[] {
  const cutoff = input.now.getTime() - NOW_ACTIVITY_WINDOW_MS;
  const asksByTask = new Map<number, NowAsk[]>();
  for (const a of input.openQuestions) {
    const list = asksByTask.get(a.taskId) ?? [];
    list.push(a);
    asksByTask.set(a.taskId, list);
  }
  const linksByTask = new Map<number, NowSessionLink[]>();
  for (const l of input.sessionLinks) {
    const list = linksByTask.get(l.taskId) ?? [];
    list.push(l);
    linksByTask.set(l.taskId, list);
  }

  const out: NowStory[] = [];
  for (const story of input.stories) {
    if (STORY_CLOSED_STATUSES.includes(story.status)) continue;
    const project = input.projects.get(story.projectId);
    if (!project) continue;
    const children = [...(input.children.get(story.id) ?? [])].sort(byQueueOrder);
    const family = [story, ...children];

    // newest link per session across the story and its children
    const sessions = new Map<string, NowSessionLink>();
    for (const t of family) {
      for (const l of linksByTask.get(t.id) ?? []) {
        const seen = sessions.get(l.sessionId);
        if (!seen || l.lastSeenAt > seen.lastSeenAt) sessions.set(l.sessionId, l);
      }
    }
    const lastActivity = maxDate([...family.map((t) => input.lastEventAt.get(t.id)), ...[...sessions.values()].map((l) => l.lastSeenAt)]);

    const hasActiveChild = children.some((c) => ACTIVE_CHILD_STATUSES.has(c.status));
    const recentlyActive = lastActivity !== null && lastActivity.getTime() >= cutoff;
    if (!hasActiveChild && !recentlyActive) continue;

    const waiting: NowWaiting[] = [];
    for (const t of family) {
      for (const a of (asksByTask.get(t.id) ?? []).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
        waiting.push({ kind: "ask", taskId: t.id, title: t.title, askId: a.id, question: a.question });
      }
    }
    for (const c of children) {
      if (REVIEW_STATUSES.has(c.status)) waiting.push({ kind: "review", taskId: c.id, title: c.title });
    }
    for (const c of children) {
      if (c.executorMode === "human" && HUMAN_WAITING_STATUSES.has(c.status)) waiting.push({ kind: "human", taskId: c.id, title: c.title });
    }

    const counted = children.filter((c) => c.status !== "rejected");
    const next = children.find((c) => c.status === "queued");
    let interactiveCostUsd = 0;
    for (const id of sessions.keys()) interactiveCostUsd += input.interactiveCostBySession.get(id) ?? 0;

    out.push({
      id: story.id,
      title: story.title,
      status: story.status,
      project,
      progress: { done: counted.filter((c) => c.status === "done").length, total: counted.length },
      running: children.filter((c) => RUNNING_STATUSES.has(c.status)).map((c) => ({ id: c.id, title: c.title, status: c.status })),
      waiting,
      next: next ? { id: next.id, title: next.title } : null,
      sessions: [...sessions.values()]
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .slice(0, MAX_SESSIONS)
        .map((l) => ({ sessionId: l.sessionId, cwd: l.cwd, lastSeenAt: l.lastSeenAt.toISOString() })),
      interactiveCostUsd: Math.round(interactiveCostUsd * 1e6) / 1e6,
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
    });
  }

  // anything waiting on the operator first, then the most recently active
  return out.sort((a, b) => {
    const w = Number(b.waiting.length > 0) - Number(a.waiting.length > 0);
    if (w !== 0) return w;
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : -Infinity;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : -Infinity;
    return tb !== ta ? tb - ta : b.id - a.id;
  });
}

export interface FinishedSession {
  sessionId: string;
  cwd: string | null;
  lastSeenAt: string;
  stories: { id: number; title: string; status: string }[];
}

export interface LinkedTask {
  id: number;
  title: string;
  status: string;
  taskType: string;
}

export const MAX_FINISHED_SESSIONS = 20;

// Sessions every one of whose linked tasks belongs to a closed story: a
// story stands for itself, a story's child for its parent story, and a task
// with no story parent for itself. Those sessions can be archived. Newest
// first, at most MAX_FINISHED_SESSIONS.
export function buildFinishedSessions(
  links: readonly NowSessionLink[],
  linkedTasks: ReadonlyMap<number, LinkedTask>,
  parentOf: ReadonlyMap<number, number>,
): FinishedSession[] {
  const owner = (taskId: number): LinkedTask | undefined => {
    const task = linkedTasks.get(taskId);
    if (!task || task.taskType === "story") return task;
    const parentId = parentOf.get(taskId);
    const parent = parentId === undefined ? undefined : linkedTasks.get(parentId);
    return parent && parent.taskType === "story" ? parent : task;
  };
  const bySession = new Map<string, { latest: NowSessionLink; owners: Map<number, LinkedTask>; open: boolean }>();
  for (const l of links) {
    const entry = bySession.get(l.sessionId) ?? { latest: l, owners: new Map(), open: false };
    if (l.lastSeenAt > entry.latest.lastSeenAt) entry.latest = l;
    const o = owner(l.taskId);
    if (!o || !STORY_CLOSED_STATUSES.includes(o.status)) entry.open = true;
    else entry.owners.set(o.id, o);
    bySession.set(l.sessionId, entry);
  }
  return [...bySession.values()]
    .filter((e) => !e.open)
    .sort((a, b) => b.latest.lastSeenAt.getTime() - a.latest.lastSeenAt.getTime())
    .slice(0, MAX_FINISHED_SESSIONS)
    .map((e) => ({
      sessionId: e.latest.sessionId,
      cwd: e.latest.cwd,
      lastSeenAt: e.latest.lastSeenAt.toISOString(),
      stories: [...e.owners.values()].sort((a, b) => a.id - b.id).map((o) => ({ id: o.id, title: o.title, status: o.status })),
    }));
}

const nowTaskColumns = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  status: tasks.status,
  executorMode: tasks.executorMode,
  priority: tasks.priority,
  createdAt: tasks.createdAt,
};

// Parent/child rows exist in both directions, see task-model.ts's parentMap.
// `side` picks whether `ids` are the parents or the children.
async function relationsFor(ids: number[], side: "parent" | "child"): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const asParent = side === "parent";
  const relations = await db
    .select({ fromTaskId: taskRelations.fromTaskId, toTaskId: taskRelations.toTaskId, relationType: taskRelations.relationType })
    .from(taskRelations)
    .where(
      or(
        and(eq(taskRelations.relationType, "parent"), inArray(asParent ? taskRelations.toTaskId : taskRelations.fromTaskId, ids)),
        and(eq(taskRelations.relationType, "child"), inArray(asParent ? taskRelations.fromTaskId : taskRelations.toTaskId, ids)),
      ),
    );
  return parentMap(relations);
}

// Every linked session is read, since an old finished session is as
// archivable as a new one; the table holds one row per (session, task).
export async function loadFinishedSessions(now = new Date()): Promise<FinishedSession[]> {
  const cutoff = new Date(now.getTime() - FINISHED_SESSIONS_WINDOW_MS);
  // Every link of each recently seen session, so an old link to an open story
  // still keeps that session out of the list.
  const recent = db
    .select({ sessionId: sessionLinks.sessionId })
    .from(sessionLinks)
    .groupBy(sessionLinks.sessionId)
    .having(sqlRaw`max(${sessionLinks.lastSeenAt}) >= ${cutoff.toISOString()}::timestamptz`);
  const links = await db
    .select({ sessionId: sessionLinks.sessionId, taskId: sessionLinks.taskId, cwd: sessionLinks.cwd, lastSeenAt: sessionLinks.lastSeenAt })
    .from(sessionLinks)
    .where(inArray(sessionLinks.sessionId, recent));
  if (!links.length) return [];
  const taskIds = [...new Set(links.map((l) => l.taskId))];
  const parentOf = await relationsFor(taskIds, "child");
  const ids = [...new Set([...taskIds, ...parentOf.values()])];
  const rows = await db
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, taskType: tasks.taskType })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  return buildFinishedSessions(links, new Map(rows.map((r) => [r.id, r])), parentOf);
}

export interface NowResponse {
  generatedAt: string;
  stories: NowStory[];
  finishedSessions: FinishedSession[];
}

export async function loadNow(now = new Date()): Promise<NowResponse> {
  const [stories, finishedSessions] = await Promise.all([
    db
      .select(nowTaskColumns)
      .from(tasks)
      .where(and(eq(tasks.taskType, "story"), notInArray(tasks.status, STORY_CLOSED_STATUSES))),
    loadFinishedSessions(now),
  ]);
  if (!stories.length) return { generatedAt: now.toISOString(), stories: [], finishedSessions };
  const storyIds = stories.map((s) => s.id);
  const parents = await relationsFor(storyIds, "parent");
  const childIds = [...parents.keys()];
  const childRows = childIds.length ? await db.select(nowTaskColumns).from(tasks).where(inArray(tasks.id, childIds)) : [];
  const children = new Map<number, NowTask[]>();
  for (const c of childRows) {
    const parentId = parents.get(c.id)!;
    const list = children.get(parentId) ?? [];
    list.push(c);
    children.set(parentId, list);
  }

  const allIds = [...new Set([...storyIds, ...childIds])];
  const projectIds = [...new Set(stories.map((s) => s.projectId))];
  const [projectRows, eventRows, askRows, linkRows] = await Promise.all([
    db.select({ id: projects.id, slug: projects.slug, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)),
    db
      .select({ taskId: taskEvents.taskId, at: sqlRaw<Date>`max(${taskEvents.createdAt})`.mapWith(taskEvents.createdAt) })
      .from(taskEvents)
      .where(inArray(taskEvents.taskId, allIds))
      .groupBy(taskEvents.taskId),
    db
      .select({ id: taskAsks.id, taskId: taskAsks.taskId, question: taskAsks.question, createdAt: taskAsks.createdAt })
      .from(taskAsks)
      .where(and(inArray(taskAsks.taskId, allIds), eq(taskAsks.status, "open"), eq(taskAsks.kind, "question"))),
    db
      .select({ sessionId: sessionLinks.sessionId, taskId: sessionLinks.taskId, cwd: sessionLinks.cwd, lastSeenAt: sessionLinks.lastSeenAt })
      .from(sessionLinks)
      .where(inArray(sessionLinks.taskId, allIds)),
  ]);

  const sessionIds = [...new Set(linkRows.map((l) => l.sessionId))];
  const costRows = sessionIds.length
    ? await db
        .select({ sessionId: usageEvents.sessionId, total: sqlRaw<string>`sum(${usageEvents.costUsd}::numeric)` })
        .from(usageEvents)
        .where(and(eq(usageEvents.source, "interactive"), inArray(usageEvents.sessionId, sessionIds)))
        .groupBy(usageEvents.sessionId)
    : [];

  return {
    generatedAt: now.toISOString(),
    finishedSessions,
    stories: buildNowStories({
      now,
      stories,
      children,
      projects: new Map(projectRows.map((p) => [p.id, p])),
      lastEventAt: new Map(eventRows.filter((e) => e.taskId !== null).map((e) => [e.taskId!, e.at])),
      openQuestions: askRows,
      sessionLinks: linkRows,
      interactiveCostBySession: new Map(costRows.map((r) => [r.sessionId!, Number(r.total)])),
    }),
  };
}

// Upserts one session_links row per known task id; unknown ids are skipped.
// A repeated report widens [first_seen_at, last_seen_at] and replaces cwd
// only when the new report carries one. Returns the rows written.
export async function upsertSessionLinks(input: { sessionId: string; cwd?: string; taskIds: readonly number[]; at: Date }): Promise<number> {
  const wanted = [...new Set(input.taskIds)];
  if (!wanted.length) return 0;
  const existing = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, wanted));
  if (!existing.length) return 0;
  const rows = await db
    .insert(sessionLinks)
    .values(existing.map((t) => ({ sessionId: input.sessionId, taskId: t.id, cwd: input.cwd ?? null, firstSeenAt: input.at, lastSeenAt: input.at })))
    .onConflictDoUpdate({
      target: [sessionLinks.sessionId, sessionLinks.taskId],
      set: {
        firstSeenAt: sqlRaw`least(${sessionLinks.firstSeenAt}, excluded.first_seen_at)`,
        lastSeenAt: sqlRaw`greatest(${sessionLinks.lastSeenAt}, excluded.last_seen_at)`,
        cwd: sqlRaw`coalesce(excluded.cwd, ${sessionLinks.cwd})`,
      },
    })
    .returning({ taskId: sessionLinks.taskId });
  return rows.length;
}
