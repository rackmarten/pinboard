import { and, eq, gte } from "drizzle-orm";
import { db, sql } from "./db/client.js";
import { projects, tasks } from "./db/schema.js";
import { sendMail } from "./mailer.js";
import { getWeeklyResetSetting } from "./settings.js";

export interface DailyCost {
  day: string; // YYYY-MM-DD
  costUsd: number;
  count: number;
}

export interface UsageSummary {
  todayUsd: number;
  monthUsd: number;
  // since the operator's configured weekly plan-allowance reset
  // (settings.ts's getWeeklyResetSetting), not a fixed Mon-00:00 calendar
  // week - a calendar week reads as near-empty right after a mid-week reset
  // (e.g. Friday 16:00) even though real spend since the actual reset is
  // high.
  sinceResetUsd: number;
  resetStart: string; // ISO timestamp of the most recent weekly reset used above
  daily: DailyCost[];
}

// Most recent occurrence of the configured day-of-week/hour at or before
// `now` - the mirror image of governor.ts's nextWeeklyReset (which finds the
// next one), kept separate and pure so it doesn't disturb that function's
// existing unit tests.
export function currentWeeklyResetStart(now: Date, dayOfWeek: number, hour: number): Date {
  const start = new Date(now);
  start.setHours(hour, 0, 0, 0);
  let daysBack = (start.getDay() - dayOfWeek + 7) % 7;
  if (daysBack === 0 && start.getTime() > now.getTime()) daysBack = 7;
  start.setDate(start.getDate() - daysBack);
  return start;
}

// costUsd on `handoffs` is stored as text (see schema.ts's note on why) so
// every aggregate needs an explicit ::numeric cast - drizzle's query builder
// has no clean way to express that, hence the raw `sql` (same postgres.js
// tag db/client.ts already exposes for index.ts's health check).
async function sumCostSince(cutoff: Date): Promise<number> {
  const [row] = await sql<{ total: string | null }[]>`
    select coalesce(sum(cost_usd::numeric), 0) as total
    from handoffs
    where created_at >= ${cutoff.toISOString()}
  `;
  return Number(row?.total ?? 0);
}

export async function getUsageSummary(days = 30): Promise<UsageSummary> {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(startOfToday);
  startOfMonth.setDate(startOfMonth.getDate() - 29);
  const rangeStart = new Date(startOfToday);
  rangeStart.setDate(rangeStart.getDate() - (days - 1));

  const { dayOfWeek, hour } = await getWeeklyResetSetting();
  const resetStart = currentWeeklyResetStart(now, dayOfWeek, hour);

  const [todayUsd, sinceResetUsd, monthUsd, dailyRows] = await Promise.all([
    sumCostSince(startOfToday),
    sumCostSince(resetStart),
    sumCostSince(startOfMonth),
    sql<{ day: string; total: string; count: string }[]>`
      select date_trunc('day', created_at)::date as day,
             coalesce(sum(cost_usd::numeric), 0) as total,
             count(*) as count
      from handoffs
      where created_at >= ${rangeStart.toISOString()}
      group by day
      order by day
    `,
  ]);

  const byDay = new Map(dailyRows.map((r) => [r.day, { costUsd: Number(r.total), count: Number(r.count) }]));
  const daily: DailyCost[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(rangeStart);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const found = byDay.get(key);
    daily.push({ day: key, costUsd: found?.costUsd ?? 0, count: found?.count ?? 0 });
  }

  return { todayUsd, sinceResetUsd, resetStart: resetStart.toISOString(), monthUsd, daily };
}

export interface TaskCost {
  taskId: number;
  title: string;
  projectId: number;
  totalCostUsd: number;
  sinceResetCostUsd: number;
}

export interface ProjectCost {
  projectId: number;
  slug: string;
  name: string;
  parentProjectId: number | null;
  // Own tasks' cost only.
  ownCostUsd: number;
  ownSinceResetCostUsd: number;
  // Own tasks' cost plus every descendant project's own cost, recursively -
  // this is what a parent project's tile should show, per a past task ("rolled
  // up per parent project as the sum of its child projects' spend").
  rolledUpCostUsd: number;
  rolledUpSinceResetCostUsd: number;
}

export interface CostRollup {
  resetStart: string;
  tasks: TaskCost[];
  projects: ProjectCost[];
}

// cost per task, rolled up per project and per parent project, so
// a project's AI credit spend can be weighed against the value it produced.
// One query joining handoffs to tasks, aggregated in JS rather than a second
// SQL grouping - the row counts here (tasks, projects) are homelab-scale, and
// aggregating in JS keeps the parent-rollup logic (arbitrary depth, cycle-safe)
// in one place instead of a second, harder-to-read recursive SQL query.
export async function getCostRollup(): Promise<CostRollup> {
  const { dayOfWeek, hour } = await getWeeklyResetSetting();
  const resetStart = currentWeeklyResetStart(new Date(), dayOfWeek, hour);

  const [taskRows, projectRows] = await Promise.all([
    sql<{ task_id: number; title: string; project_id: number; total: string; since_reset: string }[]>`
      select t.id as task_id, t.title, t.project_id,
             coalesce(sum(h.cost_usd::numeric), 0) as total,
             coalesce(sum(h.cost_usd::numeric) filter (where h.created_at >= ${resetStart.toISOString()}), 0) as since_reset
      from tasks t
      left join handoffs h on h.task_id = t.id
      group by t.id, t.title, t.project_id
    `,
    db.select().from(projects),
  ]);

  const tasksCost: TaskCost[] = taskRows.map((r) => ({
    taskId: r.task_id,
    title: r.title,
    projectId: r.project_id,
    totalCostUsd: Number(r.total),
    sinceResetCostUsd: Number(r.since_reset),
  }));

  const ownByProject = new Map<number, { total: number; sinceReset: number }>();
  for (const t of tasksCost) {
    const acc = ownByProject.get(t.projectId) ?? { total: 0, sinceReset: 0 };
    acc.total += t.totalCostUsd;
    acc.sinceReset += t.sinceResetCostUsd;
    ownByProject.set(t.projectId, acc);
  }

  const projectsById = new Map(projectRows.map((p) => [p.id, p]));
  const rolledUp = new Map<number, { total: number; sinceReset: number }>(
    projectRows.map((p) => [p.id, { total: 0, sinceReset: 0 }]),
  );
  for (const p of projectRows) {
    const own = ownByProject.get(p.id) ?? { total: 0, sinceReset: 0 };
    const visited = new Set<number>();
    let cur: typeof p | undefined = p;
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      const acc = rolledUp.get(cur.id)!;
      acc.total += own.total;
      acc.sinceReset += own.sinceReset;
      cur = cur.parentProjectId ? projectsById.get(cur.parentProjectId) : undefined;
    }
  }

  const projectsCost: ProjectCost[] = projectRows.map((p) => {
    const own = ownByProject.get(p.id) ?? { total: 0, sinceReset: 0 };
    const rolled = rolledUp.get(p.id)!;
    return {
      projectId: p.id,
      slug: p.slug,
      name: p.name,
      parentProjectId: p.parentProjectId,
      ownCostUsd: own.total,
      ownSinceResetCostUsd: own.sinceReset,
      rolledUpCostUsd: rolled.total,
      rolledUpSinceResetCostUsd: rolled.sinceReset,
    };
  });

  return { resetStart: resetStart.toISOString(), tasks: tasksCost, projects: projectsCost };
}

export interface DigestData {
  periodHours: number;
  costUsd: number;
  completed: { id: number; title: string }[];
  waitingReview: { id: number; title: string }[];
  failed: { id: number; title: string }[];
}

// "What ran / what failed" reads off `tasks.status` + `updatedAt` rather
// than `task_events`, matching every other status-transition query in
// routes.ts - both /complete, /reject and the runner's own rework path
// bump `updatedAt` alongside `status`, so this needs no separate event join.
export async function gatherDigestData(periodHours = 24): Promise<DigestData> {
  const cutoff = new Date(Date.now() - periodHours * 3_600_000);

  const [costUsd, completed, waitingReview, failed] = await Promise.all([
    sumCostSince(cutoff),
    db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(and(eq(tasks.status, "done"), gte(tasks.updatedAt, cutoff))),
    db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.status, "review")),
    db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(and(eq(tasks.status, "rework"), gte(tasks.updatedAt, cutoff))),
  ]);

  return { periodHours, costUsd, completed, waitingReview, failed };
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatTaskList(items: { id: number; title: string }[]): string {
  if (!items.length) return "  none";
  return items.map((t) => `  #${t.id} ${t.title}`).join("\n");
}

export function buildDigestText(data: DigestData): string {
  return [
    `Pinboard daily digest - last ${data.periodHours}h`,
    "",
    `Cost: ${formatUsd(data.costUsd)}`,
    "",
    `Completed (${data.completed.length}):`,
    formatTaskList(data.completed),
    "",
    `Waiting for review (${data.waitingReview.length}):`,
    formatTaskList(data.waitingReview),
    "",
    `Failed / rework (${data.failed.length}):`,
    formatTaskList(data.failed),
  ].join("\n");
}

export async function runDailyDigest(periodHours = 24): Promise<{ sent: boolean; reason?: string }> {
  const data = await gatherDigestData(periodHours);
  const text = buildDigestText(data);
  const today = new Date().toISOString().slice(0, 10);
  return sendMail(`Pinboard daily digest - ${today}`, text);
}
