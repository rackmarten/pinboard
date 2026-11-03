// the depends_on gate against the database. The rules themselves are pure
// and live in task-model.ts (dependencyGate, unmergedDependencies); this
// module only loads what they need, so the planner, the task route's
// stackOn and the approve guard can't drift apart.
import { and, eq, inArray } from "drizzle-orm";
import { db, sql } from "./db/client.js";
import { comments, pullRequests, taskRelations, tasks } from "./db/schema.js";
import { recordEvent } from "./journal.js";
import { dependencyGate, isReviewMode, unmergedDependencies, type DependencyTarget, type ReviewMode } from "./task-model.js";

export interface DependentTargets {
  mode: ReviewMode;
  targets: DependencyTarget[];
}

interface TargetRow {
  from_task_id: number;
  review_mode: string;
  task_id: number;
  status: string;
  pr_states: string[];
}

// every unfinished depends_on target, grouped by dependent, with the
// dependent's project review mode. Finished targets (done, rejected) are left
// out: they satisfy any gate, so loading them would change nothing.
export async function loadDependencyTargets(fromTaskIds?: readonly number[]): Promise<Map<number, DependentTargets>> {
  if (fromTaskIds && fromTaskIds.length === 0) return new Map();
  const rows = await sql<TargetRow[]>`
    select r.from_task_id, dp.review_mode, t.id as task_id, t.status,
      coalesce(array_agg(p.state) filter (where p.id is not null), '{}') as pr_states
    from task_relations r
    join tasks t on t.id = r.to_task_id
    join tasks d on d.id = r.from_task_id
    join projects dp on dp.id = d.project_id
    left join pull_requests p on p.task_id = t.id
    where r.relation_type = 'depends_on'
      and t.status not in ('done', 'rejected')
      ${fromTaskIds ? sql`and r.from_task_id in ${sql(fromTaskIds as number[])}` : sql``}
    group by r.from_task_id, dp.review_mode, t.id, t.status
  `;
  return groupTargetRows(rows);
}

export function groupTargetRows(rows: readonly TargetRow[]): Map<number, DependentTargets> {
  const out = new Map<number, DependentTargets>();
  for (const row of rows) {
    let entry = out.get(row.from_task_id);
    if (!entry) {
      entry = { mode: isReviewMode(row.review_mode) ? row.review_mode : "standard", targets: [] };
      out.set(row.from_task_id, entry);
    }
    entry.targets.push({ taskId: row.task_id, status: row.status, prStates: row.pr_states });
  }
  return out;
}

// tasks a depends_on target still holds back, the set the planner skips.
export function blockedIds(byDependent: ReadonlyMap<number, DependentTargets>): Set<number> {
  const blocked = new Set<number>();
  for (const [id, { mode, targets }] of byDependent) if (dependencyGate(mode, targets).blocked) blocked.add(id);
  return blocked;
}

export async function blockedTaskIds(): Promise<Set<number>> {
  return blockedIds(await loadDependencyTargets());
}

export interface StackOn {
  taskId: number;
  pullRequests: { url: string; repoSlug: string; branchName: string | null }[];
}

// the dependency a playtest task's branch is cut from, with that task's open
// PRs (one per repo it touched) so foreman can pick the one in its repo.
export async function stackOnFor(taskId: number): Promise<StackOn | null> {
  const entry = (await loadDependencyTargets([taskId])).get(taskId);
  if (!entry) return null;
  const gate = dependencyGate(entry.mode, entry.targets);
  if (gate.blocked || gate.stackOnTaskId == null) return null;
  const prs = await db
    .select({ url: pullRequests.url, repoSlug: pullRequests.repoSlug, branchName: pullRequests.branchName })
    .from(pullRequests)
    .where(and(eq(pullRequests.taskId, gate.stackOnTaskId), eq(pullRequests.state, "open")));
  return { taskId: gate.stackOnTaskId, pullRequests: prs };
}

// dependencies that must merge before this playtest task's own PR may. Empty
// in a standard project, where a task could only start once they had.
export async function mergeBlockers(taskId: number): Promise<number[]> {
  const entry = (await loadDependencyTargets([taskId])).get(taskId);
  if (!entry || entry.mode !== "playtest") return [];
  return unmergedDependencies(entry.targets);
}

// statuses a stacked dependent sits in once its PR exists but before a human
// has approved it. Pipeline statuses after that (awaiting_merge, deploying)
// can't happen while the parent is unmerged: the approve guard refuses them.
const RESTACK_STATUSES = ["review", "awaiting_review"];

// a playtest task was rejected outright: dependents that stacked a PR on it
// carry its rejected work, so they go back to rework to be rebuilt on main.
// Dependents still running only get the comment, since their run owns the
// task; it reaches review with the comment already on it.
export async function reworkStackedDependents(parentId: number, actor: { actorType: string; actorName: string }): Promise<number[]> {
  const rows = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(taskRelations)
    .innerJoin(tasks, eq(tasks.id, taskRelations.fromTaskId))
    .where(and(eq(taskRelations.toTaskId, parentId), eq(taskRelations.relationType, "depends_on")));
  if (rows.length === 0) return [];
  const [parentProject] = await sql<{ review_mode: string }[]>`
    select p.review_mode from tasks t join projects p on p.id = t.project_id where t.id = ${parentId}
  `;
  if (parentProject?.review_mode !== "playtest") return [];
  const openPrs = await db
    .select({ taskId: pullRequests.taskId })
    .from(pullRequests)
    .where(and(inArray(pullRequests.taskId, rows.map((r) => r.id)), eq(pullRequests.state, "open")));
  const withPr = new Set(openPrs.map((p) => p.taskId));
  const body = `Parent #${parentId} was rejected. Rebuild this on main without it.`;
  const moved: number[] = [];
  for (const row of rows) {
    if (!withPr.has(row.id) && row.status !== "executing") continue;
    const [comment] = await db.insert(comments).values({ taskId: row.id, authorType: "system", authorName: "pinboard", body }).returning({ id: comments.id });
    await recordEvent({ taskId: row.id, eventType: "comment", actorType: "system", actorName: "pinboard", payload: { commentId: comment.id } });
    if (!RESTACK_STATUSES.includes(row.status)) continue;
    await db.update(tasks).set({ status: "rework", updatedAt: new Date() }).where(eq(tasks.id, row.id));
    await recordEvent({ taskId: row.id, eventType: "status", ...actor, payload: { from: row.status, to: "rework", reason: body } });
    moved.push(row.id);
  }
  return moved;
}
