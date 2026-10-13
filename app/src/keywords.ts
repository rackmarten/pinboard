// tasks and projects carry a `keywords` tsvector (server-kit's
// keyword search), so the top-bar search ignores diacritics and word order.
// Every insert sets it, and every update touching these fields refreshes it.
import { eq, isNull } from "drizzle-orm";
import { keywordsVector } from "@rackmarten/server-kit";
import { db } from "./db/client.js";
import { projects, tasks } from "./db/schema.js";

export const TASK_KEYWORD_FIELDS = ["title", "description"] as const;
export const PROJECT_KEYWORD_FIELDS = ["name"] as const;

export type TaskText = { title?: string | null; description?: string | null };
type ProjectText = { name?: string | null };

export const taskKeywords = (t: TaskText) => keywordsVector(t, TASK_KEYWORD_FIELDS);
export const projectKeywords = (p: ProjectText) => keywordsVector(p, PROJECT_KEYWORD_FIELDS);

/** Fills `keywords` for rows that have none (rows from before 0036). Idempotent. */
export async function backfillKeywords(): Promise<number> {
  const taskRows = await db.select({ id: tasks.id, title: tasks.title, description: tasks.description }).from(tasks).where(isNull(tasks.keywords));
  for (const t of taskRows) await db.update(tasks).set({ keywords: taskKeywords(t) }).where(eq(tasks.id, t.id));
  const projectRows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(isNull(projects.keywords));
  for (const p of projectRows) await db.update(projects).set({ keywords: projectKeywords(p) }).where(eq(projects.id, p.id));
  return taskRows.length + projectRows.length;
}
