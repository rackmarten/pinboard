import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "./db/client.js";
import { activityEvents, activityMinutes, operatorSettings, taskAsks, taskEvents, tasks } from "./db/schema.js";
import { actorFromHeaders, actorKey, identitySettings, type Actor } from "./identity.js";

// How each operator spends time in pinboard. The PWA's tracker
// (pwa/src/activity-tracker.ts) counts active seconds per route and module
// and clicks per feature, and flushes them here about once a minute. Nothing
// is recorded for an operator who has not opted in (operator_settings,
// default off). The "waiting on a human" figures below are derived from the
// journal and asks, nothing new is recorded for them.

export const ACTIVITY_KINDS = ["active", "click"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const RAW_RETENTION_DAYS = 90;
export const MAX_BATCH_ENTRIES = 1000;
const MAX_NAME_LENGTH = 200;
const MAX_CLICKS_PER_ENTRY = 1000;
// A flush delayed by a sleeping laptop is still worth keeping; a minute far
// outside this window is a broken clock, not activity.
const MAX_AGE_MS = 7 * 24 * 3600_000;
const MAX_FUTURE_MS = 5 * 60_000;

export interface ActivityEntry {
  kind: ActivityKind;
  minute: Date; // start of the minute
  route: string;
  name: string;
  value: number;
}

export class ActivityError extends Error {
  statusCode = 400;
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

// Checks a flush and folds entries for the same (kind, minute, route, name)
// together, since one upsert statement cannot touch the same row twice.
// Entries outside the time window are dropped rather than failing the batch:
// the tracker cannot see an error from a beacon anyway.
export function normalizeBatch(body: unknown, now = new Date()): ActivityEntry[] {
  const entries = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new ActivityError("entries must be an array");
  if (entries.length > MAX_BATCH_ENTRIES) throw new ActivityError(`at most ${MAX_BATCH_ENTRIES} entries per batch`);
  const merged = new Map<string, ActivityEntry>();
  for (const raw of entries) {
    const e = raw as Record<string, unknown>;
    if (!ACTIVITY_KINDS.includes(e?.kind as ActivityKind)) throw new ActivityError("kind must be active or click");
    if (!isName(e.route) || !isName(e.name)) throw new ActivityError(`route and name must be 1-${MAX_NAME_LENGTH} characters`);
    const max = e.kind === "active" ? 60 : MAX_CLICKS_PER_ENTRY;
    if (!Number.isInteger(e.value) || (e.value as number) < 1 || (e.value as number) > max) {
      throw new ActivityError(`value must be an integer 1-${max} for ${e.kind}`);
    }
    const at = new Date(typeof e.minute === "string" || typeof e.minute === "number" ? e.minute : NaN);
    if (Number.isNaN(at.getTime())) throw new ActivityError("minute must be a timestamp");
    if (at.getTime() < now.getTime() - MAX_AGE_MS || at.getTime() > now.getTime() + MAX_FUTURE_MS) continue;
    at.setUTCSeconds(0, 0);
    const kind = e.kind as ActivityKind;
    const key = [kind, at.toISOString(), e.route, e.name].join("\u0000");
    const found = merged.get(key);
    if (found) found.value = kind === "active" ? Math.min(60, found.value + (e.value as number)) : found.value + (e.value as number);
    else merged.set(key, { kind, minute: at, route: e.route, name: e.name, value: e.value as number });
  }
  return [...merged.values()];
}

export interface MinuteRow {
  minute: Date;
  kind: string;
  route: string;
  name: string;
  value: number;
}

export interface ActivitySummary {
  totalActiveMinutes: number;
  daily: { day: string; activeMinutes: number }[];
  modules: { route: string; module: string; activeMinutes: number }[];
  features: { feature: string; clicks: number }[];
}

export const TOP_N = 10;

// Server-local calendar day, YYYY-MM-DD.
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minutes(seconds: number): number {
  return Math.round((seconds / 60) * 10) / 10;
}

// `days` days ending today (server-local), every day present so a chart's
// gaps are real.
export function summarizeActivity(rows: MinuteRow[], now: Date, days: number): ActivitySummary {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const perDay = new Map<string, number>();
  const perModule = new Map<string, { route: string; module: string; seconds: number }>();
  const perFeature = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (r.minute < start) continue;
    if (r.kind === "active") {
      total += r.value;
      const day = localDay(r.minute);
      perDay.set(day, (perDay.get(day) ?? 0) + r.value);
      const key = `${r.route}\u0000${r.name}`;
      const m = perModule.get(key) ?? { route: r.route, module: r.name, seconds: 0 };
      m.seconds += r.value;
      perModule.set(key, m);
    } else if (r.kind === "click") {
      perFeature.set(r.name, (perFeature.get(r.name) ?? 0) + r.value);
    }
  }
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const day = localDay(d);
    daily.push({ day, activeMinutes: minutes(perDay.get(day) ?? 0) });
  }
  return {
    totalActiveMinutes: minutes(total),
    daily,
    modules: [...perModule.values()]
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, TOP_N)
      .map((m) => ({ route: m.route, module: m.module, activeMinutes: minutes(m.seconds) })),
    features: [...perFeature.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([feature, clicks]) => ({ feature, clicks })),
  };
}

// --- waiting on a human ------------------------------------------------------

export interface JournalStatusEvent {
  taskId: number;
  at: Date;
  eventType: string;
  payload: Record<string, unknown> | null;
}

export interface Interval {
  taskId: number;
  start: Date;
  end: Date;
}

// The status a journal event leaves its task in, or null for an event that
// does not move it. Most moves carry `to`; claim/complete/reject predate that
// and imply theirs.
export function statusAfter(e: JournalStatusEvent): string | null {
  const to = e.payload?.to;
  if ((e.eventType === "status" || e.eventType === "pipeline") && typeof to === "string") return to;
  if (e.eventType === "created" && typeof e.payload?.status === "string") return e.payload.status;
  if (e.eventType === "claim") return "executing";
  if (e.eventType === "complete") return "done";
  if (e.eventType === "reject") return "rework";
  return null;
}

// Closed stretches each task spent in `status`. A stretch that began before
// the first event we were given has no start and is skipped; one still open
// has no end and is skipped too (it has not finished waiting).
export function statusIntervals(events: JournalStatusEvent[], status: string): Interval[] {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const entered = new Map<number, Date>();
  const out: Interval[] = [];
  for (const e of sorted) {
    const next = statusAfter(e);
    if (next === null) continue;
    const since = entered.get(e.taskId);
    if (next === status) {
      if (!since) entered.set(e.taskId, e.at);
    } else if (since) {
      out.push({ taskId: e.taskId, start: since, end: e.at });
      entered.delete(e.taskId);
    }
  }
  return out;
}

// Monday 00:00, server-local.
export function weekStart(d: Date): Date {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export interface WaitStat {
  count: number;
  medianHours: number | null;
  meanHours: number | null;
  totalHours: number;
}

export interface WaitingWeek {
  weekStart: string; // YYYY-MM-DD, a Monday
  asks: WaitStat;
  review: WaitStat;
  defined: WaitStat;
  humanQueued: WaitStat;
}

export const WAIT_CATEGORIES = ["asks", "review", "defined", "humanQueued"] as const;
export type WaitCategory = (typeof WAIT_CATEGORIES)[number];

function hours(ms: number): number {
  return Math.round((ms / 3600_000) * 100) / 100;
}

export function waitStat(durationsMs: number[]): WaitStat {
  if (!durationsMs.length) return { count: 0, medianHours: null, meanHours: null, totalHours: 0 };
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const total = sorted.reduce((s, n) => s + n, 0);
  return { count: sorted.length, medianHours: hours(median), meanHours: hours(total / sorted.length), totalHours: hours(total) };
}

// The last `weeks` weeks, oldest first, the current one included. A wait
// counts in the week it ended.
export function weeklyWaiting(intervals: Record<WaitCategory, Interval[]>, now: Date, weeks: number): WaitingWeek[] {
  const starts: Date[] = [];
  const current = weekStart(now);
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(current);
    d.setDate(d.getDate() - 7 * i);
    starts.push(d);
  }
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? new Date(8.64e15);
    const stat = (list: Interval[]) =>
      waitStat(list.filter((iv) => iv.end >= start && iv.end < end).map((iv) => iv.end.getTime() - iv.start.getTime()));
    return {
      weekStart: localDay(start),
      asks: stat(intervals.asks),
      review: stat(intervals.review),
      defined: stat(intervals.defined),
      humanQueued: stat(intervals.humanQueued),
    };
  });
}

export interface WaitingInputs {
  questions: { taskId: number; createdAt: Date; answeredAt: Date }[];
  events: JournalStatusEvent[];
  executorModes: Map<number, string>;
}

// Which tasks each journal-derived figure is about: review is every task,
// `defined` only tasks an agent would run, `queued` only a person's own.
export function waitingIntervals(inputs: WaitingInputs): Record<WaitCategory, Interval[]> {
  const mode = (taskId: number) => inputs.executorModes.get(taskId) ?? "human";
  return {
    asks: inputs.questions.map((q) => ({ taskId: q.taskId, start: q.createdAt, end: q.answeredAt })),
    review: statusIntervals(inputs.events, "review"),
    defined: statusIntervals(
      inputs.events.filter((e) => mode(e.taskId) !== "human"),
      "defined",
    ),
    humanQueued: statusIntervals(
      inputs.events.filter((e) => mode(e.taskId) === "human"),
      "queued",
    ),
  };
}

// --- storage -----------------------------------------------------------------

export interface ActivityStore {
  trackingEnabled(actorKey: string): Promise<boolean>;
  setTracking(actorKey: string, enabled: boolean): Promise<void>;
  record(actorKey: string, entries: ActivityEntry[]): Promise<void>;
  minutesSince(actorKey: string, since: Date): Promise<MinuteRow[]>;
  waitingInputs(since: Date): Promise<WaitingInputs>;
}

const STATUS_EVENT_TYPES = ["status", "pipeline", "created", "claim", "complete", "reject"];

export const dbActivityStore: ActivityStore = {
  async trackingEnabled(key) {
    const [row] = await db.select().from(operatorSettings).where(eq(operatorSettings.actorKey, key)).limit(1);
    return row?.usageTracking ?? false;
  },
  async setTracking(key, enabled) {
    await db
      .insert(operatorSettings)
      .values({ actorKey: key, usageTracking: enabled })
      .onConflictDoUpdate({ target: operatorSettings.actorKey, set: { usageTracking: enabled, updatedAt: new Date() } });
  },
  async record(key, entries) {
    if (!entries.length) return;
    const rows = entries.map((e) => ({ actorKey: key, kind: e.kind, minute: e.minute, route: e.route, name: e.name, value: e.value }));
    await db.transaction(async (tx) => {
      await tx.insert(activityEvents).values(rows);
      await tx
        .insert(activityMinutes)
        .values(rows)
        .onConflictDoUpdate({
          target: [activityMinutes.actorKey, activityMinutes.minute, activityMinutes.kind, activityMinutes.route, activityMinutes.name],
          // a minute holds at most 60 active seconds, however many tabs report it
          set: {
            value: sql`case when excluded.kind = 'active' then least(60, ${activityMinutes.value} + excluded.value) else ${activityMinutes.value} + excluded.value end`,
          },
        });
    });
  },
  async minutesSince(key, since) {
    return db
      .select({ minute: activityMinutes.minute, kind: activityMinutes.kind, route: activityMinutes.route, name: activityMinutes.name, value: activityMinutes.value })
      .from(activityMinutes)
      .where(and(eq(activityMinutes.actorKey, key), gte(activityMinutes.minute, since)));
  },
  async waitingInputs(since) {
    const [questions, events] = await Promise.all([
      db
        .select({ taskId: taskAsks.taskId, createdAt: taskAsks.createdAt, answeredAt: taskAsks.answeredAt })
        .from(taskAsks)
        .where(and(eq(taskAsks.kind, "question"), isNotNull(taskAsks.answeredAt), gte(taskAsks.answeredAt, since))),
      db
        .select({ taskId: taskEvents.taskId, at: taskEvents.createdAt, eventType: taskEvents.eventType, payload: taskEvents.payload })
        .from(taskEvents)
        .where(and(isNotNull(taskEvents.taskId), inArray(taskEvents.eventType, STATUS_EVENT_TYPES), gte(taskEvents.createdAt, since))),
    ]);
    const taskIds = [...new Set(events.map((e) => e.taskId as number))];
    const modes = taskIds.length
      ? await db.select({ id: tasks.id, executorMode: tasks.executorMode }).from(tasks).where(inArray(tasks.id, taskIds))
      : [];
    return {
      questions: questions.map((q) => ({ taskId: q.taskId, createdAt: q.createdAt, answeredAt: q.answeredAt as Date })),
      events: events.map((e) => ({ taskId: e.taskId as number, at: e.at, eventType: e.eventType, payload: e.payload as Record<string, unknown> | null })),
      executorModes: new Map(modes.map((m) => [m.id, m.executorMode])),
    };
  },
};

// Raw rows go after RAW_RETENTION_DAYS; activity_minutes is kept.
export async function pruneActivity(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RAW_RETENTION_DAYS * 24 * 3600_000);
  const deleted = await db.delete(activityEvents).where(lt(activityEvents.receivedAt, cutoff)).returning({ id: activityEvents.id });
  return deleted.length;
}

// --- routes ------------------------------------------------------------------

// Only a person is tracked. Anything else (a script, foreman) reads as off
// and cannot turn it on.
function requestActor(req: { headers: Record<string, string | string[] | undefined>; query: unknown }): Actor {
  return actorFromHeaders(req.headers, identitySettings(), (req.query ?? {}) as Record<string, unknown>);
}

const MAX_DAYS = 365;
const MAX_WEEKS = 52;
// A wait ending in the window may have started well before it.
const WAIT_LOOKBACK_DAYS = 30;

function boundedInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
}

export async function registerActivityRoutes(app: FastifyInstance, store: ActivityStore = dbActivityStore): Promise<void> {
  app.get("/me/settings", async (req) => {
    const actor = requestActor(req);
    const human = actor.actorType === "human";
    return { actor: actorKey(actor), usageTracking: human && (await store.trackingEnabled(actorKey(actor))) };
  });

  app.put("/me/settings", async (req, reply) => {
    const actor = requestActor(req);
    if (actor.actorType !== "human") return reply.code(403).send({ error: "only a person's own settings can be changed" });
    const body = (req.body ?? {}) as { usageTracking?: unknown };
    if (typeof body.usageTracking !== "boolean") return reply.code(400).send({ error: "usageTracking must be true or false" });
    await store.setTracking(actorKey(actor), body.usageTracking);
    return { actor: actorKey(actor), usageTracking: body.usageTracking };
  });

  // The tracker's flush (fetch every minute, sendBeacon on pagehide). With
  // tracking off it is accepted and dropped, so a tab opened before the
  // switch was turned off never writes another row.
  app.post("/activity", async (req, reply) => {
    const actor = requestActor(req);
    let entries: ActivityEntry[];
    try {
      entries = normalizeBatch(req.body);
    } catch (err) {
      if (err instanceof ActivityError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    if (actor.actorType === "human" && (await store.trackingEnabled(actorKey(actor)))) {
      await store.record(actorKey(actor), entries);
    }
    return reply.code(204).send();
  });

  // The Usage view's "My time" tab: the requesting operator's own activity,
  // plus the waiting-on-a-human figures, which are everyone's.
  app.get("/usage/my-time", async (req) => {
    const q = (req.query ?? {}) as { days?: string; weeks?: string };
    const days = boundedInt(q.days, 30, MAX_DAYS);
    const weeks = boundedInt(q.weeks, 8, MAX_WEEKS);
    const now = new Date();
    const actor = requestActor(req);
    const key = actorKey(actor);
    const activityStart = new Date(now);
    activityStart.setHours(0, 0, 0, 0);
    activityStart.setDate(activityStart.getDate() - (days - 1));
    const waitStart = weekStart(now);
    waitStart.setDate(waitStart.getDate() - 7 * (weeks - 1) - WAIT_LOOKBACK_DAYS);
    const [usageTracking, rows, inputs] = await Promise.all([
      actor.actorType === "human" ? store.trackingEnabled(key) : Promise.resolve(false),
      store.minutesSince(key, activityStart),
      store.waitingInputs(waitStart),
    ]);
    return {
      actor: key,
      usageTracking,
      days,
      activity: summarizeActivity(rows, now, days),
      waiting: weeklyWaiting(waitingIntervals(inputs), now, weeks),
    };
  });
}
