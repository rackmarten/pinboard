import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { notifications, projects, taskEvents, tasks } from "./db/schema.js";
import { deriveNotification } from "./notifications.js";
import { pushGate } from "./push.js";
import { healthKey, pushCategory } from "./push-policy.js";

// the journal - one append-only record of who changed what and
// when, across tasks, projects, chat and settings. Everything that writes to
// task_events goes through recordEvent here, which is also where
// notifications are derived, so a new journaled action gets a notification
// by adding a rule to notifications.ts rather than by remembering to call a
// second function at each call site.

export interface JournalInput {
  taskId?: number | null;
  projectId?: number | null;
  eventType: string;
  actorType: string;
  actorName: string;
  payload?: Record<string, unknown> | null;
}

export async function recordEvent(input: JournalInput): Promise<void> {
  const taskId = input.taskId ?? null;
  let task: { id: number; title: string; projectId: number } | null = null;
  if (taskId !== null) {
    const [row] = await db
      .select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    task = row ?? null;
  }
  const projectId = input.projectId ?? task?.projectId ?? null;
  const payload = input.payload ?? null;

  const [event] = await db
    .insert(taskEvents)
    .values({ taskId, projectId, eventType: input.eventType, actorType: input.actorType, actorName: input.actorName, payload })
    .returning({ id: taskEvents.id });

  const draft = deriveNotification({ ...input, taskId, payload }, task);
  if (!draft) return;
  const [notification] = await db
    .insert(notifications)
    .values({ eventId: event.id, taskId, projectId, ...draft })
    .returning({ id: notifications.id });

  // Fire-and-forget (ntfy since a past task). A slow or failing push must never
  // hold up (or fail) the API call that journaled the event - the in-app
  // bell already has the notification either way. the gate
  // decides whether (and when) it reaches the phone at all.
  const event_ = { ...input, taskId, payload };
  pushGate.offer({ id: notification.id, ...draft }, pushCategory(event_, draft), healthKey(event_), new Date());
}

export interface JournalQuery {
  taskId?: number;
  projectId?: number;
  beforeId?: number;
  limit?: number;
  // only these event types (the releases view's History).
  eventTypes?: string[];
}

// Newest first, keyset-paginated on id (ids are monotonic with createdAt,
// and unlike a timestamp they never tie within one batch).
export async function listJournal(q: JournalQuery) {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const where = [];
  if (q.taskId !== undefined) where.push(eq(taskEvents.taskId, q.taskId));
  if (q.projectId !== undefined) where.push(eq(taskEvents.projectId, q.projectId));
  if (q.beforeId !== undefined) where.push(lt(taskEvents.id, q.beforeId));
  if (q.eventTypes?.length) where.push(inArray(taskEvents.eventType, q.eventTypes));
  return db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      projectId: taskEvents.projectId,
      eventType: taskEvents.eventType,
      actorType: taskEvents.actorType,
      actorName: taskEvents.actorName,
      payload: taskEvents.payload,
      createdAt: taskEvents.createdAt,
      taskTitle: tasks.title,
      projectSlug: projects.slug,
    })
    .from(taskEvents)
    .leftJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .leftJoin(projects, eq(projects.id, taskEvents.projectId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(taskEvents.id))
    .limit(limit);
}

export const JOURNAL_RETENTION_MONTHS = 3;

// Detailed payloads are dropped after JOURNAL_RETENTION_MONTHS, the rows
// themselves are kept: "who did what when" stays answerable, the bulky
// detail goes. Read notifications older than that are deleted outright -
// unread ones are kept, since deleting something nobody has seen yet would
// be losing it rather than tidying it. Returns counts for the log line.
export async function pruneJournal(now = new Date()): Promise<{ payloads: number; notifications: number }> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - JOURNAL_RETENTION_MONTHS);
  const pruned = await db
    .update(taskEvents)
    .set({ payload: null })
    .where(and(lt(taskEvents.createdAt, cutoff), isNotNull(taskEvents.payload)))
    .returning({ id: taskEvents.id });
  const deleted = await db
    .delete(notifications)
    .where(and(lt(notifications.createdAt, cutoff), isNotNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return { payloads: pruned.length, notifications: deleted.length };
}

export async function unreadNotificationCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(sql`${notifications.readAt} is null`);
  return row?.n ?? 0;
}
