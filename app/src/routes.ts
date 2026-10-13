import { and, eq, desc, gt, inArray, isNull, isNotNull, or, sql as sqlRaw } from "drizzle-orm";
import { keywordSearch } from "@rackmarten/server-kit";
import { projectKeywords, taskKeywords, type TaskText } from "./keywords.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "./db/client.js";
import {
  projects,
  tasks,
  labels,
  taskLabels,
  taskRelations,
  comments,
  pullRequests,
  agents,
  routingRules,
  handoffs,
  taskEvents,
  notifications,
  chatThreads,
  chatMessages,
  chatEvents,
  chatPermissionRules,
  sessionLimitReports,
  licenses,
} from "./db/schema.js";
import { getCostRollup, getUsageSummary, InteractiveDedupe, licenseIdForLinuxUser, runDailyDigest } from "./usage.js";
import { normalizeTaskEnums, parentMap, storyShouldComplete, isTerminalStatus, dependencySatisfied } from "./task-model.js";
import { readinessApplies, readinessFailures, toWorkspaceRepos, type ReadinessTask, type WorkspaceRepo } from "./readiness.js";
import { listJournal, recordEvent as recordJournalEvent, unreadNotificationCount } from "./journal.js";
import { pushConfigured, sendTestPush } from "./push.js";
import { config } from "./config.js";
import { asksForTask } from "./asks.js";
import {
  ChatEventError,
  EVENTS_PER_THREAD_CAP,
  activeRulesForTurn,
  formatSseFrame,
  normalizeEventBatch,
  normalizePermissionRule,
  normalizePermissionDecision,
  normalizeQuestionAnswer,
  isForemanStreamEvent,
} from "./chat-events.js";
import { publishChat, subscribeChat, subscriberCount, type ChatBusMessage } from "./chat-bus.js";
import { createLicense, getDefaultLicenseId, getLicense, listLicenses, resetSessionWindow, updateLicense } from "./licenses.js";
import { validateRecurrencePatch } from "./recurrence.js";
import {
  getPlannerSettings,
  getWeeklyResetSetting,
  updatePlannerSettings,
  updateWeeklyResetSetting,
  validateBoolean,
  validateDayOfWeek,
  validateHour,
  validatePositiveInteger,
  validatePositiveNumber,
} from "./settings.js";
import {
  createBudgetPeriod,
  getCurrentBudgetPeriod,
  getPlan,
  getPlanGate,
  getPlanNext,
  liveSessionLimitReset,
  listBudgetPeriods,
  recordUsageEvent,
  updateBudgetPeriod,
} from "./plan.js";
import {
  applyTransition,
  checkTransition,
  openPrBlocksDone,
  getPipelineNext,
  isRepairReason,
  keepRepairOnPatch,
  type RepairReason,
} from "./pipeline.js";
import {
  checkGrantable,
  checkOperatorRequest,
  checkQueueMove,
  grantState,
  ROOT_GRANT_FIELDS,
  ROOT_LABEL,
  validateRootScope,
  validateTtlHours,
} from "./root-grants.js";
import {
  checkConcurrencyForClaim,
  deriveObservationFromUsage,
  getGovernorStatus,
  listBudgetRateHistory,
  listBudgetRates,
  listObservations,
  recordBudgetRate,
  recordObservation,
  validatePercent,
  validateRate,
  validateScope,
  type Scope,
} from "./governor.js";

// Story-point-like AI effort scale, not engineering time - see
// idea-task-management.md's "Cost Estimation". Constrained here rather than
// left as a bare integer: the I0 spike found an unconstrained effort field
// let the model invent a value of 1000.
const EFFORT_LEVELS = [1, 2, 3, 5, 8, 13];

// how often an idle SSE connection writes a comment line. Short
// enough to stay well inside any default proxy/idle timeout in the path
// (Caddy, the tailnet), long enough that an open stream costs nothing
// meaningful.
const SSE_HEARTBEAT_MS = 20_000;

// What foreman's whole-firehose subscription is actually for: the things it
// cannot observe from inside its own session. Its own transcript events are
// filtered out - it wrote them.

// I10: task relations, directional fromTaskId -> toTaskId - see schema.ts's
// comment on taskRelations for what each value means.
const RELATION_TYPES = ["parent", "child", "related", "depends_on"];

function validateRelationType(value: unknown): string {
  if (!RELATION_TYPES.includes(value as string)) {
    throw badRequest(`relationType must be one of ${RELATION_TYPES.join(", ")}`);
  }
  return value as string;
}

// The executors foreman actually runs: "cli" is the full worktree/PR
// pipeline and a seat's default runner, "cli-host" the unrestricted chat
// persona, "8ball" the LLM gateway path (reached only through a routing
// rule). Anything else would be skipped by dispatch, so it is refused here.
// Rows saved before this check stay readable; only writes are validated.
export const AGENT_EXECUTORS = ["cli", "cli-host", "8ball"];

function validateAgentExecutor(value: unknown): string {
  if (!AGENT_EXECUTORS.includes(value as string)) {
    throw badRequest(`executor must be one of ${AGENT_EXECUTORS.join(", ")}`);
  }
  return value as string;
}

// I15: pull request lifecycle state, kept fresh by foreman polling `gh pr view`.
const PR_STATES = ["open", "merged", "closed"];

// every workspace repo, for the readiness lint's coverage rule.
async function workspaceRepos(): Promise<WorkspaceRepo[]> {
  return toWorkspaceRepos(await db.select({ id: projects.id, localPath: projects.localPath, repoUrl: projects.repoUrl }).from(projects));
}

// an agent task only enters `queued` ready to run, unless forced.
async function readinessGate(task: Record<string, unknown>, reply: FastifyReply): Promise<boolean> {
  if (task.executorMode !== "agent") return true;
  const failures = readinessFailures(task as ReadinessTask, await workspaceRepos());
  if (!failures.length) return true;
  reply.code(422).send({ error: "task is not ready to queue", failures });
  return false;
}

// an open PR row means the work is not merged yet, so closing the
// task would leak it. Approving merges it instead (review -> awaiting_merge).
async function hasOpenPr(taskId: number): Promise<boolean> {
  const rows = await db.select({ state: pullRequests.state }).from(pullRequests).where(eq(pullRequests.taskId, taskId));
  return openPrBlocksDone(rows.map((r) => r.state), false);
}
const OPEN_PR_ERROR = "task has an open pull request - approve merges it; send force:true to mark it done without merging";

function validatePrState(value: unknown): string {
  if (!PR_STATES.includes(value as string)) {
    throw badRequest(`state must be one of ${PR_STATES.join(", ")}`);
  }
  return value as string;
}

// parent task id for each of `taskIds`, from task_relations'
// parent/child rows - one query for the whole list, not one per task.
async function parentIdsFor(taskIds: number[]): Promise<Map<number, number>> {
  if (!taskIds.length) return new Map();
  const rows = await db
    .select({ fromTaskId: taskRelations.fromTaskId, toTaskId: taskRelations.toTaskId, relationType: taskRelations.relationType })
    .from(taskRelations)
    .where(
      or(
        and(eq(taskRelations.relationType, "parent"), inArray(taskRelations.fromTaskId, taskIds)),
        and(eq(taskRelations.relationType, "child"), inArray(taskRelations.toTaskId, taskIds)),
      ),
    );
  return parentMap(rows);
}

async function childIdsOf(parentId: number): Promise<number[]> {
  const rows = await db
    .select({ fromTaskId: taskRelations.fromTaskId, toTaskId: taskRelations.toTaskId, relationType: taskRelations.relationType })
    .from(taskRelations)
    .where(
      or(
        and(eq(taskRelations.relationType, "parent"), eq(taskRelations.toTaskId, parentId)),
        and(eq(taskRelations.relationType, "child"), eq(taskRelations.fromTaskId, parentId)),
      ),
    );
  return [...new Set(rows.map((r) => (r.relationType === "parent" ? r.fromTaskId : r.toTaskId)))];
}

// once a child lands in done/rejected, its story follows to done
// if every one of its children is now terminal. Called after every route that
// can move a task into a terminal status.
async function completeStoryIfFinished(childId: number, childStatus: string): Promise<void> {
  if (!isTerminalStatus(childStatus)) return;
  const parentId = (await parentIdsFor([childId])).get(childId);
  if (parentId === undefined) return;
  const [story] = await db.select().from(tasks).where(eq(tasks.id, parentId));
  if (!story || story.taskType !== "story") return;
  const childIds = await childIdsOf(parentId);
  const children = await db.select({ status: tasks.status }).from(tasks).where(inArray(tasks.id, childIds));
  if (!storyShouldComplete(story.status, children.map((c) => c.status))) return;
  await db
    .update(tasks)
    .set({ status: "done", rootGrantExpiresAt: revokeGrantSql, updatedAt: new Date() })
    .where(eq(tasks.id, parentId));
  await recordEvent(parentId, "status", "system", "pinboard", {
    from: story.status,
    to: "done",
    reason: `all children finished (last: #${childId})`,
  });
}

function badRequest(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

// rejects a project hierarchy edit that would make a project its
// own ancestor - the schema itself has no DB-level FK/constraint against
// this (see schema.ts's comment on parentProjectId), so it's enforced here
// instead. excludeId is the project being edited (undefined on create,
// where no cycle is possible yet since the row doesn't exist).
async function assertNoProjectCycle(parentProjectId: number, excludeId?: number): Promise<void> {
  let currentId: number | null = parentProjectId;
  const seen = new Set<number>();
  while (currentId !== null) {
    if (currentId === excludeId) throw badRequest("parentProjectId would create a cycle");
    if (seen.has(currentId)) break; // pre-existing cycle unrelated to this edit - don't loop forever
    seen.add(currentId);
    const [row] = await db
      .select({ parentProjectId: projects.parentProjectId })
      .from(projects)
      .where(eq(projects.id, currentId));
    currentId = row?.parentProjectId ?? null;
  }
}

// relatedProjectIds references projects.id directly (not a repo
// slug/path string), so a bogus id would silently resolve to nothing later
// when foreman looks up a project's localPath - worth catching at write
// time instead.
async function assertProjectIdsExist(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const found = await db.select({ id: projects.id }).from(projects).where(inArray(projects.id, ids));
  const foundIds = new Set(found.map((p) => p.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length) throw badRequest(`no project(s) with id ${missing.join(", ")}`);
}

function validateEffort(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!EFFORT_LEVELS.includes(value as number)) {
    throw badRequest(`estimatedEffort must be one of ${EFFORT_LEVELS.join(", ")}`);
  }
  return value as number;
}

function requireActor(body: Record<string, unknown>): { actorType: string; actorName: string } {
  const actorType = body.actorType as string | undefined;
  const actorName = body.actorName as string | undefined;
  if (!actorType || !actorName) throw badRequest("actorType and actorName are required");
  return { actorType, actorName };
}

async function recordEvent(
  taskId: number,
  eventType: string,
  actorType: string,
  actorName: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await recordJournalEvent({ taskId, eventType, actorType, actorName, payload });
}

// who is behind a request that carries no explicit actor. Most
// write routes predate provenance and take none, so the PWA marks itself
// with `x-pinboard-client: pwa` (a person at a browser), a script or agent
// can name itself with `x-pinboard-actor: <type>:<name>`, and anything else
// is journaled as an unnamed API caller rather than guessed at.
export function actorFromRequest(req: FastifyRequest): { actorType: string; actorName: string } {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.actorType === "string" && typeof body.actorName === "string") {
    return { actorType: body.actorType, actorName: body.actorName };
  }
  const named = req.headers["x-pinboard-actor"];
  if (typeof named === "string" && named.includes(":")) {
    const [actorType, ...rest] = named.split(":");
    return { actorType, actorName: rest.join(":") };
  }
  if (req.headers["x-pinboard-client"] === "pwa") return { actorType: "human", actorName: "operator" };
  return { actorType: "system", actorName: "api" };
}

// whether a task carries the `root-access` label, which is what
// puts it behind root-grants.ts's queue gate.
async function hasRootLabel(taskId: number): Promise<boolean> {
  const rows = await db
    .select({ id: labels.id })
    .from(taskLabels)
    .innerJoin(labels, eq(taskLabels.labelId, labels.id))
    .where(and(eq(taskLabels.taskId, taskId), eq(labels.name, ROOT_LABEL)));
  return rows.length > 0;
}

// ends a root grant now without losing who granted what. least()
// leaves a task that never had a grant at null.
const revokeGrantSql = sqlRaw`least(${tasks.rootGrantExpiresAt}, now())`;

// Fields whose change is worth a journal line. Lease renewals, heartbeats
// and bookkeeping columns are PATCHed constantly by foreman and would bury
// everything else.
const JOURNALED_TASK_FIELDS = [
  "title",
  "description",
  "taskType",
  "executorMode",
  "priority",
  "autonomyLevel",
  "estimatedEffort",
  "relatedProjectIds",
  "projectId",
  "rootScope",
];

// config screens (agents, licenses, routing rules, settings,
// budget periods, labels) journaled by one hook rather than one call per
// route - their changes are rare, so the route and changed field names are
// enough to answer "who changed this and when".
// every route below is registered under this prefix (index.ts).
export const API_PREFIX = "/api";

const CONFIG_ROUTE_PREFIXES = ["/agents", "/licenses", "/routing-rules", "/settings", "/plan/periods", "/labels", "/governor/rates"];

// One per process, shared by every POST /usage - see usage.ts.
const interactiveDedupe = new InteractiveDedupe();

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // /health is registered by server-kit's createApp (see index.ts).

  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || reply.statusCode >= 400) return;
    // Journaled without the /api prefix so history reads the same before and after a past task.
    const route = (req.routeOptions?.url ?? req.url).replace(/^\/api(?=\/)/, "");
    if (!CONFIG_ROUTE_PREFIXES.some((prefix) => route.startsWith(prefix))) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      await recordJournalEvent({
        eventType: "config_changed",
        ...actorFromRequest(req),
        payload: { method: req.method, route, params: req.params, fields: Object.keys(body) },
      });
    } catch (err) {
      req.log.error({ err }, "journaling a config change failed");
    }
  });

  // the journal, newest first. taskId/projectId narrow it to one
  // task or project; beforeId pages backwards; types (comma list) narrows
  // it to those event types.
  app.get("/events", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
    const eventTypes = q.types ? q.types.split(",").filter(Boolean) : undefined;
    return listJournal({ taskId: num(q.taskId), projectId: num(q.projectId), beforeId: num(q.beforeId), limit: num(q.limit), eventTypes });
  });

  // scripts/backup.sh reports each run here, so a failed nightly
  // backup reaches the notification bell instead of only the container log.
  app.post("/backups/report", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.outcome !== "succeeded" && body.outcome !== "failed") return reply.code(400).send({ error: "outcome must be succeeded or failed" });
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 500) : null;
    await recordJournalEvent({ eventType: "backup", ...actorFromRequest(req), payload: { outcome: body.outcome, detail } });
    reply.code(204);
  });

  // foreman (or any other watcher) reports a dependency starting
  // to fail or recovering. The reporter dedups, so this journals every call;
  // notifications.ts turns it into a bell entry. `project` is a slug, and an
  // unknown one journals without a project rather than refusing the alert.
  app.post("/health/report", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.check !== "string" || !body.check.trim()) return reply.code(400).send({ error: "check is required" });
    if (body.status !== "failing" && body.status !== "recovered") return reply.code(400).send({ error: "status must be failing or recovered" });
    let projectId: number | null = null;
    if (typeof body.project === "string") {
      const [row] = await db.select({ id: projects.id }).from(projects).where(eq(projects.slug, body.project));
      projectId = row?.id ?? null;
    }
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 500) : null;
    await recordJournalEvent({
      eventType: "health",
      projectId,
      ...actorFromRequest(req),
      payload: { check: body.check.trim().slice(0, 100), status: body.status, detail },
    });
    reply.code(204);
  });

  app.get("/notifications", async (req) => {
    const q = req.query as { unread?: string; limit?: string; beforeId?: string };
    const where = [];
    if (q.unread === "true") where.push(isNull(notifications.readAt));
    if (q.beforeId) where.push(sqlRaw`${notifications.id} < ${Number(q.beforeId)}`);
    return db
      .select()
      .from(notifications)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(notifications.id))
      .limit(Math.min(Number(q.limit ?? 50) || 50, 200));
  });

  app.get("/notifications/unread-count", async () => ({ unread: await unreadNotificationCount() }));

  app.post("/notifications/:id/read", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.id, id), isNull(notifications.readAt)));
    reply.code(204);
  });

  app.post("/notifications/read-all", async (_req, reply) => {
    await db.update(notifications).set({ readAt: new Date() }).where(isNull(notifications.readAt));
    reply.code(204);
  });

  // the Notifications page's "Send test" - one ntfy publish to
  // pinboard's topic. Per-device subscription lives in the ntfy app now.
  app.post("/push/test", async (_req, reply) => {
    if (!pushConfigured()) return reply.code(503).send({ error: "push is not configured (NTFY_URL / NTFY_TOKEN_PINBOARD unset)" });
    const sent = await sendTestPush();
    if (!sent) return reply.code(502).send({ error: "ntfy publish failed - see pinboard-app's log" });
    return { sent: true };
  });

  // Excludes archived projects by default (the picker/list's common case) -
  // pass includeArchived=true for the projects management screen, which
  // needs to show and unarchive them too.
  app.get("/projects", async (req) => {
    // q searches project names (GlobalSearch's Projects group).
    const q = req.query as { includeArchived?: string; q?: string };
    const nameMatch = q.q?.trim() ? (keywordSearch(projects.keywords, q.q) ?? sqlRaw`false`) : undefined;
    return db
      .select()
      .from(projects)
      .where(and(q.includeArchived === "true" ? undefined : eq(projects.archived, false), nameMatch))
      .orderBy(projects.name);
  });

  app.post("/projects", async (req, reply) => {
    const body = req.body as {
      slug?: string;
      name?: string;
      description?: string;
      localPath?: string;
      repoUrl?: string;
      parentProjectId?: number | null;
      autoDeployAllowed?: boolean;
      context?: string;
      relatedProjectIds?: number[];
    };
    if (!body.slug || !body.name) throw badRequest("slug and name are required");
    if (body.parentProjectId != null) await assertNoProjectCycle(body.parentProjectId);
    await assertProjectIdsExist(body.relatedProjectIds ?? []);
    const [project] = await db
      .insert(projects)
      .values({
        slug: body.slug,
        name: body.name,
        keywords: projectKeywords(body),
        description: body.description,
        localPath: body.localPath,
        repoUrl: body.repoUrl,
        parentProjectId: body.parentProjectId ?? null,
        autoDeployAllowed: body.autoDeployAllowed ?? false,
        context: body.context,
        relatedProjectIds: body.relatedProjectIds ?? [],
      })
      .returning();
    await recordJournalEvent({ projectId: project.id, eventType: "project_created", ...actorFromRequest(req), payload: { slug: project.slug } });
    reply.code(201);
    return project;
  });

  app.get("/projects/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    if (!project) return reply.code(404).send({ error: "not found" });
    return project;
  });

  // Latest handoff(s) for a project, most recent first - powers `work plan
  // sync`'s "latest handoff" section without the CLI having to fetch every
  // task's events itself.
  app.get("/projects/:id/handoffs", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { limit?: string };
    const limit = q.limit ? Number(q.limit) : 20;
    return db
      .select({
        id: handoffs.id,
        taskId: handoffs.taskId,
        agentId: handoffs.agentId,
        completed: handoffs.completed,
        changed: handoffs.changed,
        verified: handoffs.verified,
        problems: handoffs.problems,
        discovered: handoffs.discovered,
        next: handoffs.next,
        estimatedNextEffort: handoffs.estimatedNextEffort,
        costUsd: handoffs.costUsd,
        durationMs: handoffs.durationMs,
        numTurns: handoffs.numTurns,
        permissionDenials: handoffs.permissionDenials,
        summary: handoffs.summary,
        createdAt: handoffs.createdAt,
        taskTitle: tasks.title,
      })
      .from(handoffs)
      .innerJoin(tasks, eq(handoffs.taskId, tasks.id))
      .where(eq(tasks.projectId, id))
      .orderBy(desc(handoffs.createdAt))
      .limit(limit);
  });

  // a task's handoffs, newest first - the inbox's Review cards
  // show the latest one's summary, task detail shows it on top.
  app.get("/tasks/:id/handoffs", async (req) => {
    const id = Number((req.params as { id: string }).id);
    return db.select().from(handoffs).where(eq(handoffs.taskId, id)).orderBy(desc(handoffs.createdAt)).limit(20);
  });

  app.patch("/projects/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as {
      name?: string;
      description?: string;
      localPath?: string;
      repoUrl?: string;
      parentProjectId?: number | null;
      autoDeployAllowed?: boolean;
      archived?: boolean;
      context?: string;
      relatedProjectIds?: number[];
    };
    if (body.parentProjectId != null) await assertNoProjectCycle(body.parentProjectId, id);
    if (body.relatedProjectIds) await assertProjectIdsExist(body.relatedProjectIds);
    const actor = actorFromRequest(req);
    const fields = Object.keys(body).filter((k) => k !== "actorType" && k !== "actorName");
    const update = Object.fromEntries(fields.map((k) => [k, (body as Record<string, unknown>)[k]]));
    if (typeof body.name === "string") update.keywords = projectKeywords(body);
    const [project] = await db.update(projects).set(update).where(eq(projects.id, id)).returning();
    if (!project) return reply.code(404).send({ error: "not found" });
    await recordJournalEvent({ projectId: id, eventType: "project_updated", ...actor, payload: { fields } });
    return project;
  });

  // Every query param is an optional exact-match filter - the task list
  // view's filters (idea-task-management.md's "First UI shape") are all
  // just different combinations of these.
  app.get("/tasks", async (req) => {
    const q = req.query as {
      projectId?: string;
      status?: string;
      taskType?: string;
      executorMode?: string;
      hasActiveWorktree?: string;
      // list a story's children.
      parentTaskId?: string;
      // top-bar global search - matches task ID (exact) or, since
      // #335, keywords (title + description, diacritic-free prefix words).
      q?: string;
    };
    const conditions = [];
    // projectId doubles as a comma-separated set (the Task List
    // view's default scope from the Projects screen's multi-select) - an
    // empty string means "zero projects selected", which must match nothing
    // rather than being treated as "no filter" (a missing param entirely).
    if (q.projectId === "") {
      conditions.push(eq(tasks.projectId, -1));
    } else if (q.projectId) {
      const ids = q.projectId.split(",").map(Number).filter((n) => Number.isInteger(n));
      if (ids.length === 1) conditions.push(eq(tasks.projectId, ids[0]));
      else if (ids.length > 1) conditions.push(inArray(tasks.projectId, ids));
    }
    // status doubles as a comma-separated set, same convention as
    // projectId above, so the task list's multi-select status filter can be
    // sent as one query param.
    if (q.status) {
      const statuses = q.status.split(",").filter(Boolean);
      if (statuses.length === 1) conditions.push(eq(tasks.status, statuses[0]));
      else if (statuses.length > 1) conditions.push(inArray(tasks.status, statuses));
    }
    if (q.taskType) conditions.push(eq(tasks.taskType, q.taskType));
    if (q.executorMode) conditions.push(eq(tasks.executorMode, q.executorMode));
    // foreman's worktree-retention sweep needs the small set of
    // tasks still holding a retained worktree, across every project/status,
    // rather than pulling every task to filter client-side.
    if (q.hasActiveWorktree === "true") conditions.push(isNotNull(tasks.activeWorktreeName));
    if (q.parentTaskId) {
      const childIds = await childIdsOf(Number(q.parentTaskId));
      conditions.push(childIds.length ? inArray(tasks.id, childIds) : eq(tasks.id, -1));
    }
    const searchTerm = q.q?.trim();
    if (searchTerm) {
      const taskId = Number(searchTerm);
      const textMatch = keywordSearch(tasks.keywords, searchTerm) ?? sqlRaw`false`;
      conditions.push(Number.isInteger(taskId) ? or(eq(tasks.id, taskId), textMatch)! : textMatch);
    }

    const rows = await db
      .select()
      .from(tasks)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(tasks.priority), desc(tasks.createdAt));
    const parents = await parentIdsFor(rows.map((t) => t.id));
    return rows.map((t) => ({ ...t, parentTaskId: parents.get(t.id) ?? null }));
  });

  app.post("/tasks", async (req, reply) => {
    const body = req.body as {
      projectId?: number;
      title?: string;
      description?: string;
      taskType?: string;
      status?: string;
      executorMode?: string;
      priority?: number;
      autonomyLevel?: number;
      estimatedEffort?: number;
      relatedProjectIds?: number[];
      rootScope?: unknown;
    };
    if (!body.projectId || !body.title) throw badRequest("projectId and title are required");
    const enums = normalizeTaskEnums(body as Record<string, unknown>);
    if (!enums.ok) throw badRequest(enums.reason);
    const rootScope = validateRootScope(body.rootScope ?? []);
    if (!rootScope.ok) throw badRequest(rootScope.reason);
    const estimatedEffort = validateEffort(body.estimatedEffort);
    await assertProjectIdsExist(body.relatedProjectIds ?? []);
    const force = (body as Record<string, unknown>).force === true;
    if (body.status === "queued" && !force && !(await readinessGate({ ...body, estimatedEffort }, reply))) return reply;

    const [task] = await db
      .insert(tasks)
      .values({
        projectId: body.projectId,
        title: body.title,
        description: body.description,
        keywords: taskKeywords(body),
        taskType: body.taskType ?? "implementation",
        status: body.status ?? "idea",
        executorMode: body.executorMode ?? "human",
        priority: body.priority ?? 0,
        autonomyLevel: body.autonomyLevel,
        estimatedEffort,
        relatedProjectIds: body.relatedProjectIds ?? [],
        rootScope: rootScope.ctids,
      })
      .returning();
    await recordJournalEvent({ taskId: task.id, eventType: "created", ...actorFromRequest(req), payload: { status: task.status } });
    reply.code(201);
    return task;
  });

  app.get("/tasks/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) return reply.code(404).send({ error: "not found" });

    const taskLabelRows = await db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(taskLabels)
      .innerJoin(labels, eq(taskLabels.labelId, labels.id))
      .where(eq(taskLabels.taskId, id));

    // open and recent asks, so the runner can put the Q&A into
    // the next attempt's prompt.
    return { ...task, labels: taskLabelRows, asks: await asksForTask(id) };
  });

  app.patch("/tasks/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Record<string, unknown>;
    const enums = normalizeTaskEnums(body);
    if (!enums.ok) throw badRequest(enums.reason);
    if ("estimatedEffort" in body) body.estimatedEffort = validateEffort(body.estimatedEffort);
    // JSON has no Date type, so a caller sending a timestamp field (e.g.
    // foreman's renewLease, which PATCHes leaseExpiresAt) sends an ISO
    // string - drizzle's timestamp columns expect a real Date and throw
    // ("value.toISOString is not a function") if handed a string instead.
    // Found live (2026-09-09): the first task run to actually cross a lease
    // renewal boundary (>5 minutes) hit this on every renewal attempt.
    if (typeof body.leaseExpiresAt === "string") body.leaseExpiresAt = new Date(body.leaseExpiresAt);
    if (typeof body.controlRequestedAt === "string") body.controlRequestedAt = new Date(body.controlRequestedAt);
    // Requeuing a rework/rejected task back to `queued` without a fresh
    // attempt budget means the dispatcher (I7) immediately re-hits the
    // attempt cap and flips it straight back to rework - so a plain status
    // change to `queued` resets attemptCount too, unless the caller set it
    // explicitly itself.
    if (body.status === "queued" && !("attemptCount" in body)) body.attemptCount = 0;
    // a human requeue is not a repair handback, so it must not
    // inherit one's leftovers. `repairReason`/`repairContext` are set only by
    // POST /tasks/:id/pipeline and would otherwise survive a PATCH back to
    // `queued`, leaving the next run to read a CI failure from two attempts
    // ago as the reason it was woken. Same shape as the attemptCount reset
    // above: cleared unless the caller deliberately names them.
    // A past task narrows it: see keepRepairOnPatch for which moves keep them.
    const [before] = await db.select().from(tasks).where(eq(tasks.id, id));
    // the grant columns belong to POST /tasks/:id/root-grant alone,
    // and a root-access task only moves into `queued` with a live grant.
    const grantField = ROOT_GRANT_FIELDS.find((f) => f in body);
    if (grantField) throw badRequest(`${grantField} is set only by POST /tasks/:id/root-grant`);
    if ("rootScope" in body) {
      const scope = validateRootScope(body.rootScope);
      if (!scope.ok) throw badRequest(scope.reason);
      body.rootScope = scope.ctids;
    }
    const force = body.force === true;
    delete body.force;
    if (before && body.status === "queued" && before.status !== "queued" && !force && readinessApplies(before.status)) {
      if (!(await readinessGate({ ...before, ...body }, reply))) return reply;
    }
    if (before && body.status === "done" && before.status !== "done" && !force && (await hasOpenPr(id))) {
      return reply.code(409).send({ error: OPEN_PR_ERROR });
    }
    if (before && body.status === "queued" && before.status !== "queued") {
      const gate = checkQueueMove(before.status, body.status, await hasRootLabel(id), grantState(before, new Date()).active);
      if (!gate.ok) return reply.code(409).send({ error: gate.reason });
    }
    if (body.status === "done" || body.status === "rejected") body.rootGrantExpiresAt = revokeGrantSql;
    if (typeof body.status === "string" && !("repairReason" in body) && !keepRepairOnPatch(before?.status, body.status)) {
      body.repairReason = null;
      body.repairContext = null;
    }
    if (Array.isArray(body.relatedProjectIds)) await assertProjectIdsExist(body.relatedProjectIds as number[]);
    // the session id and the license whose `~/.claude` holds it
    // are one fact in two columns, so dropping the session drops its owner
    // too. foreman always writes the pair together; this covers a human
    // clearing a stuck session from the UI (or by hand, as #166/#169 were)
    // and leaving an owner behind that no longer refers to anything.
    if ("claudeSessionId" in body && body.claudeSessionId === null) body.claudeSessionLicenseId = null;
    if ("title" in body || "description" in body) body.keywords = taskKeywords({ ...before, ...(body as TaskText) });
    const actor = actorFromRequest(req);
    delete body.actorType;
    delete body.actorName;
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    delete body.reason;
    const [task] = await db
      .update(tasks)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) return reply.code(404).send({ error: "not found" });
    if (before && before.status !== task.status) {
      await recordEvent(id, "status", actor.actorType, actor.actorName, {
        from: before.status,
        to: task.status,
        ...(reason ? { reason } : {}),
      });
      await completeStoryIfFinished(id, task.status);
    }
    const changed = JOURNALED_TASK_FIELDS.filter(
      (f) => f in body && before && JSON.stringify((before as Record<string, unknown>)[f]) !== JSON.stringify((task as Record<string, unknown>)[f]),
    );
    if (changed.length) await recordEvent(id, "updated", actor.actorType, actor.actorName, { fields: changed });
    return task;
  });

  app.get("/tasks/:id/comments", async (req) => {
    const id = Number((req.params as { id: string }).id);
    return db.select().from(comments).where(eq(comments.taskId, id)).orderBy(comments.createdAt);
  });

  app.post("/tasks/:id/comments", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { authorType?: string; authorName?: string; body?: string };
    if (!body.authorType || !body.authorName || !body.body) {
      throw badRequest("authorType, authorName and body are required");
    }
    const [comment] = await db
      .insert(comments)
      .values({ taskId: id, authorType: body.authorType, authorName: body.authorName, body: body.body })
      .returning();
    await recordEvent(id, "comment", body.authorType, body.authorName, { commentId: comment.id });
    reply.code(201);
    return comment;
  });

  // I15: structured PR/MR tracking - see schema.ts's pullRequests for why
  // this replaces the plain-text "Opened <url>" comment as the source of truth.
  app.get("/tasks/:id/pull-requests", async (req) => {
    const id = Number((req.params as { id: string }).id);
    return db.select().from(pullRequests).where(eq(pullRequests.taskId, id)).orderBy(desc(pullRequests.createdAt));
  });

  app.post("/tasks/:id/pull-requests", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { url?: string; repoSlug?: string; branchName?: string; attemptNumber?: number };
    if (!body.url || !body.repoSlug) throw badRequest("url and repoSlug are required");
    const [pr] = await db
      .insert(pullRequests)
      .values({
        taskId: id,
        url: body.url,
        repoSlug: body.repoSlug,
        branchName: body.branchName,
        attemptNumber: body.attemptNumber,
      })
      .returning();
    reply.code(201);
    return pr;
  });

  app.patch("/tasks/:id/pull-requests/:prId", async (req, reply) => {
    const prId = Number((req.params as { prId: string }).prId);
    const body = req.body as { state?: string };
    const state = validatePrState(body.state);
    const [pr] = await db
      .update(pullRequests)
      .set({ state, updatedAt: new Date() })
      .where(eq(pullRequests.id, prId))
      .returning();
    if (!pr) return reply.code(404).send({ error: "not found" });
    return pr;
  });

  // Cross-task lookup for foreman's poller, which has to re-check every open
  // PR regardless of which task it belongs to - the nested route above only
  // answers "PRs for task X".
  app.get("/pull-requests", async (req) => {
    const state = (req.query as { state?: string }).state;
    return db
      .select()
      .from(pullRequests)
      .where(state ? eq(pullRequests.state, state) : undefined);
  });

  app.get("/tasks/:id/events", async (req) => {
    const id = Number((req.params as { id: string }).id);
    return db.select().from(taskEvents).where(eq(taskEvents.taskId, id)).orderBy(taskEvents.createdAt);
  });

  // I19: live turn-by-turn activity from a running headless session (foreman's
  // runner tailing `claude -p --output-format stream-json`) - always recorded
  // as eventType "activity" rather than accepting an arbitrary type, since
  // this route's only caller is the runner and every other eventType above is
  // written internally by its own dedicated action. Lets the PWA show what an
  // unattended agent is actually doing while it runs, not just its eventual
  // handoff/comment.
  app.post("/tasks/:id/events", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { actorType?: string; actorName?: string; payload?: Record<string, unknown> };
    const { actorType, actorName } = requireActor(body);
    await recordEvent(id, "activity", actorType, actorName, body.payload);
    reply.code(201);
    return { ok: true };
  });

  // I9: convenience lookup for the task's own session chat thread (most
  // recently updated one, if more than one somehow exists) - both `work
  // task ask` and the PWA's task detail view need this same "does this
  // task have a thread, and what's its current state" question answered,
  // so it lives here once instead of both re-deriving the same filter.
  app.get("/tasks/:id/chat-thread", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.taskId, id))
      .orderBy(desc(chatThreads.updatedAt))
      .limit(1);
    if (!thread) return reply.code(404).send({ error: "not found" });
    return thread;
  });

  // I10: task relations - existed unused since I1a (free-text relationType,
  // no routes/UI). Returns both directions (this task as the subject and as
  // the object) with the other task's title/status inlined, since a
  // relation is only useful in the UI alongside enough of the linked task
  // to show at a glance without a second round trip.
  app.get("/tasks/:id/relations", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const rows = await db
      .select({
        id: taskRelations.id,
        fromTaskId: taskRelations.fromTaskId,
        toTaskId: taskRelations.toTaskId,
        relationType: taskRelations.relationType,
        createdAt: taskRelations.createdAt,
      })
      .from(taskRelations)
      .where(or(eq(taskRelations.fromTaskId, id), eq(taskRelations.toTaskId, id)));

    const otherIds = rows.map((r) => (r.fromTaskId === id ? r.toTaskId : r.fromTaskId));
    const otherTasks = otherIds.length
      ? await db
          .select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            // the PWA renders relations with the shared TaskList.
            taskType: tasks.taskType,
            executorMode: tasks.executorMode,
            priority: tasks.priority,
          })
          .from(tasks)
          .where(or(...otherIds.map((otherId) => eq(tasks.id, otherId))))
      : [];
    // whether each other task, as a depends_on target, still
    // blocks - the same rule as plan.ts's gate, so the PWA's "blocked by"
    // hints match what the dispatcher does.
    const prRows = otherIds.length
      ? await db
          .select({ taskId: pullRequests.taskId, state: pullRequests.state })
          .from(pullRequests)
          .where(inArray(pullRequests.taskId, otherIds))
      : [];
    const otherById = new Map(
      otherTasks.map((t) => [
        t.id,
        { ...t, dependencySatisfied: dependencySatisfied(t.status, prRows.filter((p) => p.taskId === t.id).map((p) => p.state)) },
      ]),
    );

    return rows.map((r) => {
      const direction = r.fromTaskId === id ? "from" : "to";
      const otherId = direction === "from" ? r.toTaskId : r.fromTaskId;
      return { ...r, direction, otherTask: otherById.get(otherId) ?? null };
    });
  });

  app.post("/tasks/:id/relations", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { toTaskId?: number; relationType?: unknown };
    if (!body.toTaskId) throw badRequest("toTaskId is required");
    if (body.toTaskId === id) throw badRequest("a task cannot relate to itself");
    const relationType = validateRelationType(body.relationType);

    const [toTask] = await db.select().from(tasks).where(eq(tasks.id, body.toTaskId));
    if (!toTask) throw badRequest(`no task ${body.toTaskId}`);

    const [relation] = await db
      .insert(taskRelations)
      .values({ fromTaskId: id, toTaskId: body.toTaskId, relationType })
      .returning();
    const actor = actorFromRequest(req);
    await recordEvent(id, "relation_added", actor.actorType, actor.actorName, { relationType, toTaskId: body.toTaskId });
    reply.code(201);
    return relation;
  });

  app.delete("/tasks/:id/relations/:relationId", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const relationId = Number((req.params as { relationId: string }).relationId);
    await db
      .delete(taskRelations)
      .where(and(eq(taskRelations.id, relationId), or(eq(taskRelations.fromTaskId, id), eq(taskRelations.toTaskId, id))));
    const actor = actorFromRequest(req);
    await recordEvent(id, "relation_removed", actor.actorType, actor.actorName, { relationId });
    reply.code(204);
  });

  // Zero-autonomy write path (PLAN.md's I3): claim/handoff/complete, each
  // stamping actorType/actorName onto a task_events row so every write has
  // provenance, per idea-task-management.md's "Agent Users / Provenance".
  app.post("/tasks/:id/claim", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Record<string, unknown>;
    const { actorType, actorName } = requireActor(body);
    // leaseSeconds is I4a's agent-runner claim: an unattended claude -p
    // session holds the task for that long, renewing periodically. A plain
    // human claim (no leaseSeconds) behaves exactly as before - always
    // succeeds, no lease set. An existing claim only blocks a new one while
    // its own lease is still live, so a crashed runner's task becomes
    // reclaimable the moment its lease lapses rather than staying stuck.
    const leaseSeconds = typeof body.leaseSeconds === "number" ? body.leaseSeconds : undefined;
    const leaseExpiresAt = leaseSeconds ? new Date(Date.now() + leaseSeconds * 1000) : null;

    const [existing] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!existing) return reply.code(404).send({ error: "not found" });
    // an agent starting a root-access task needs the operator's
    // live grant, however it got to the task (the dispatcher already skips
    // ungranted ones, but `work task run <id>` claims directly).
    if (actorType === "agent" && (await hasRootLabel(id)) && !grantState(existing, new Date()).active) {
      return reply.code(409).send({ error: `task is labelled '${ROOT_LABEL}' and has no live root grant` });
    }
    const leaseLive = existing.status === "executing" && existing.leaseExpiresAt && existing.leaseExpiresAt > new Date();
    if (leaseLive) {
      return reply.code(409).send({ error: "task is leased to a live agent run", leaseExpiresAt: existing.leaseExpiresAt });
    }

    // PLAN.md's I6: a hard concurrency cap, checked here (not just by
    // foreman's runner) so it can't be bypassed by any caller - same
    // reasoning as the lease-conflict check above.
    const concurrency = await checkConcurrencyForClaim(id, actorType, actorName);
    if (!concurrency.ok) {
      return reply.code(409).send({ error: concurrency.reason });
    }

    const [task] = await db
      .update(tasks)
      .set({ status: "executing", leaseExpiresAt, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    await recordEvent(id, "claim", actorType, actorName, leaseSeconds ? { leaseSeconds } : undefined);
    return task;
  });

  app.post("/tasks/:id/complete", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { actorType, actorName } = requireActor(req.body as Record<string, unknown>);
    if ((req.body as Record<string, unknown>).force !== true && (await hasOpenPr(id))) return reply.code(409).send({ error: OPEN_PR_ERROR });
    const [task] = await db
      .update(tasks)
      .set({ status: "done", rootGrantExpiresAt: revokeGrantSql, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) return reply.code(404).send({ error: "not found" });
    await recordEvent(id, "complete", actorType, actorName);
    await completeStoryIfFinished(id, task.status);
    return task;
  });

  // I4b: review-queue reject - approve reuses /complete (status -> done),
  // reject sends the task back to rework. Both just record the decision;
  // neither touches the PR itself (pinboard holds no GitHub credentials).
  app.post("/tasks/:id/reject", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { actorType, actorName } = requireActor(req.body as Record<string, unknown>);
    const [task] = await db
      .update(tasks)
      .set({ status: "rework", updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) return reply.code(404).send({ error: "not found" });
    await recordEvent(id, "reject", actorType, actorName);
    return task;
  });

  // A past task: the post-PR pipeline. Everything
  // between the agent opening a PR and a human looking at the result - poll
  // CI, merge, deploy, healthcheck - is plain code with no judgement in it,
  // so it runs on a cheap foreman poller instead of holding the agent slot,
  // the lease and the Claude session open for the ten-plus minutes it takes.
  // pinboard owns the state; the poller owns the doing. See pipeline.ts.
  //
  // Nothing drives these yet - #154's increment 2 builds the poller. Until
  // then this pinboard simply never sees a task in a pipeline status.
  app.get("/pipeline/next", async () => {
    return getPipelineNext();
  });

  // One legal move, checked in one place. The poller is deliberately dumb
  // about the state machine: it reports what it observed (CI went green, the
  // merge hit a conflict) and this refuses anything that is not a legal move
  // from where the task actually is, so a poller bug cannot walk a task into
  // a state the UI has no meaning for.
  app.post("/tasks/:id/pipeline", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Record<string, unknown>;
    const { actorType, actorName } = requireActor(body);
    const requested = body.to as string | undefined;
    if (!requested) throw badRequest("to is required");

    const [existing] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!existing) return reply.code(404).send({ error: "not found" });

    const check = checkTransition(existing.status, requested, body.repairReason, existing.executorMode);
    if (!check.ok) return reply.code(409).send({ error: check.reason });

    // a handback to `queued` is a move into the queue like any
    // other, so a `root-access` task whose grant has ended parks in `rework`
    // instead (evidence kept), the same place a human+agent handback goes.
    // Redirected rather than refused: the poller is stateless and reads the
    // task back, so it needs no special case.
    let to = requested;
    if (to === "queued" && (await hasRootLabel(id)) && !grantState(existing, new Date()).active) to = "rework";

    const repairReason = isRepairReason(body.repairReason) ? (body.repairReason as RepairReason) : undefined;
    const repairContext = typeof body.repairContext === "string" ? body.repairContext : undefined;
    await applyTransition(id, to, repairReason, repairContext);

    // One event per transition, so a task's own history reads as the walk it
    // actually took ("awaiting_ci -> queued, ci_failed") rather than as a
    // series of unexplained status changes. repairContext is deliberately
    // not copied into the payload - it can be an 8k CI log, and it is
    // already on the task itself for the run that needs it.
    await recordEvent(id, "pipeline", actorType, actorName, {
      from: existing.status,
      to,
      ...(to !== requested ? { requested, reason: "root grant ended" } : {}),
      ...(repairReason ? { repairReason } : {}),
    });
    // foreman closing a verified agent task is a completion like
    // /complete's, so it gets the same event for the releases history and
    // the "Done" notification.
    if (to === "done") await recordEvent(id, "complete", actorType, actorName, { via: "pipeline" });
    await completeStoryIfFinished(id, to);

    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    return task;
  });

  // I4c: the running-workers screen's kill/graceful-stop. Pinboard only
  // records the request here - foreman's runner (which polls pinboard
  // outbound, never the reverse) is what actually notices and acts on it,
  // then clears the field itself once handled. See foreman's runner.ts.
  app.post("/tasks/:id/control", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Record<string, unknown>;
    const { actorType, actorName } = requireActor(body);
    const action = body.action as string | undefined;
    if (action !== "stop" && action !== "kill") throw badRequest("action must be 'stop' or 'kill'");

    const [task] = await db
      .update(tasks)
      .set({ controlAction: action, controlRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) return reply.code(404).send({ error: "not found" });
    await recordEvent(id, "control_requested", actorType, actorName, { action });
    return task;
  });

  app.post("/tasks/:id/handoff", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Record<string, unknown>;
    const { actorType, actorName } = requireActor(body);

    let agentId: number | null = null;
    let licenseId: number | null = null;
    if (body.agentName) {
      const [agent] = await db.select().from(agents).where(eq(agents.name, body.agentName as string));
      if (!agent) throw badRequest(`no agent named ${body.agentName as string}`);
      agentId = agent.id;
      licenseId = agent.licenseId;
    }
    // usage_events.licenseId is denormalized at write time from the
    // spending agent - see schema.ts's note. Fall back to the default license
    // when no agent is named, same as any other pre-multi-license caller.
    licenseId ??= await getDefaultLicenseId();
    if ("estimatedNextEffort" in body) {
      body.estimatedNextEffort = validateEffort(body.estimatedNextEffort);
    }

    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) return reply.code(404).send({ error: "not found" });

    const [handoff] = await db
      .insert(handoffs)
      .values({
        taskId: id,
        agentId,
        completed: body.completed as string | undefined,
        changed: body.changed as string | undefined,
        verified: body.verified as string | undefined,
        problems: body.problems as string | undefined,
        discovered: body.discovered as string | undefined,
        next: body.next as string | undefined,
        estimatedNextEffort: body.estimatedNextEffort as number | undefined,
        costUsd: body.costUsd as string | undefined,
        durationMs: body.durationMs as number | undefined,
        numTurns: body.numTurns as number | undefined,
        permissionDenials: body.permissionDenials,
        summary: typeof body.summary === "string" ? body.summary : undefined,
      })
      .returning();
    // Accumulate onto the task itself (PLAN.md's I5) - a task can pick up
    // more than one handoff across retries/rework, so this adds rather than
    // overwrites. These columns existed since I1a but nothing wrote to them
    // until now - the PWA's Task type has carried them unused since I1b.
    const addedCostUsd = Number(body.costUsd ?? 0);
    const addedDurationMs = Number(body.durationMs ?? 0);
    await db
      .update(tasks)
      .set({
        status: "handoff",
        actualCostUsd: (Number(task.actualCostUsd ?? 0) + addedCostUsd).toFixed(4),
        actualDurationMs: (task.actualDurationMs ?? 0) + addedDurationMs,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id));
    await recordEvent(id, "handoff", actorType, actorName, { handoffId: handoff.id });
    // the flat cost time series the planner derives 5h session
    // windows and period spend from - see schema.ts's usageEvents note. Written
    // alongside the handoff row rather than instead of it.
    await recordUsageEvent({
      costUsd: Number(handoff.costUsd ?? 0),
      source: "handoff",
      licenseId,
      taskId: id,
      handoffId: handoff.id,
    });
    // a handoff's costUsd is a new real usage entry - refresh the
    // auto-derived governor % for both scopes so it tracks spend between the
    // operator's manual allowance checks instead of only updating then. Kept
    // running after #139 moved gating to $ so the % history stays continuous,
    // but nothing gates on it any more.
    await Promise.all([deriveObservationFromUsage("week"), deriveObservationFromUsage("session")]);
    reply.code(201);
    return handoff;
  });

  app.get("/agents", async () => db.select().from(agents).orderBy(agents.name));

  app.post("/agents", async (req, reply) => {
    const body = req.body as {
      name?: string;
      role?: string;
      provider?: string;
      model?: string;
      executor?: string;
      autonomyLevel?: number;
      credentialRef?: string;
      routingWeight?: number;
      enabled?: boolean;
      licenseId?: number;
      isHost?: boolean;
    };
    // every agent belongs to exactly one license - required here
    // the same way name/provider/executor already are, rather than falling
    // back silently, since which license an agent runs under is a deliberate
    // operator decision (it picks the Linux user foreman dispatches as).
    if (!body.name || !body.provider || !body.executor || !body.licenseId) {
      throw badRequest("name, provider, executor and licenseId are required");
    }
    validateAgentExecutor(body.executor);
    const [agent] = await db
      .insert(agents)
      .values({ ...body, name: body.name, provider: body.provider, executor: body.executor, licenseId: body.licenseId })
      .returning();
    reply.code(201);
    return agent;
  });

  // name isn't patchable - foreman resolves an agent by name (routing.ts,
  // credentialRef lookups), same reason /projects doesn't let slug change.
  app.patch("/agents/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as {
      role?: string;
      provider?: string;
      model?: string;
      executor?: string;
      autonomyLevel?: number;
      credentialRef?: string;
      routingWeight?: number;
      enabled?: boolean;
      licenseId?: number;
      isHost?: boolean;
    };
    // req.body is only cast, not schema-validated - a stray "name" field
    // would otherwise pass straight through to .set() despite the type above.
    delete (req.body as Record<string, unknown>).name;
    if (body.executor !== undefined) validateAgentExecutor(body.executor);
    const [agent] = await db.update(agents).set(body).where(eq(agents.id, id)).returning();
    if (!agent) return reply.code(404).send({ error: "not found" });
    return agent;
  });

  // an account/license under a provider - see schema.ts's
  // licenses comment. Mirrors /agents' CRUD shape (list/create/patch, no
  // delete, name not patchable).
  app.get("/licenses", async () => listLicenses());

  app.post("/licenses", async (req, reply) => {
    const body = req.body as {
      name?: string;
      provider?: string;
      linuxUser?: string;
      tokenEnvVar?: string | null;
      sessionBudgetUsd?: number | null;
      concurrencyLimit?: number | null;
      enabled?: boolean;
    };
    if (!body.name || !body.provider || !body.linuxUser) {
      throw badRequest("name, provider and linuxUser are required");
    }
    const license = await createLicense({ ...body, name: body.name, provider: body.provider, linuxUser: body.linuxUser });
    reply.code(201);
    return license;
  });

  app.patch("/licenses/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as {
      provider?: string;
      linuxUser?: string;
      tokenEnvVar?: string | null;
      sessionBudgetUsd?: number | null;
      concurrencyLimit?: number | null;
      recurrenceEnabled?: boolean;
      recurrenceBudgetUsd?: number | null;
      enabled?: boolean;
    };
    delete (req.body as Record<string, unknown>).name;
    // weekly recurrence, validated against the stored state.
    if (body.recurrenceEnabled !== undefined || body.recurrenceBudgetUsd !== undefined) {
      const current = await getLicense(id);
      if (!current) return reply.code(404).send({ error: "not found" });
      try {
        Object.assign(body, validateRecurrencePatch(body, current));
      } catch (err) {
        throw badRequest(err instanceof Error ? err.message : String(err));
      }
    }
    const license = await updateLicense(id, body);
    if (!license) return reply.code(404).send({ error: "not found" });
    return license;
  });

  // I12a: which agent should run a task when none is explicitly requested -
  // consumed by foreman's dispatcher (see its own routing.ts), not enforced
  // here. taskType/labelName both null means "matches anything".
  app.get("/routing-rules", async () => db.select().from(routingRules).orderBy(desc(routingRules.priority)));

  app.post("/routing-rules", async (req, reply) => {
    const body = req.body as {
      taskType?: string;
      labelName?: string;
      agentId?: number;
      priority?: number;
      enabled?: boolean;
    };
    if (!body.agentId) throw badRequest("agentId is required");
    const [rule] = await db
      .insert(routingRules)
      .values({ ...body, agentId: body.agentId })
      .returning();
    reply.code(201);
    return rule;
  });

  app.patch("/routing-rules/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as {
      taskType?: string | null;
      labelName?: string | null;
      agentId?: number;
      priority?: number;
      enabled?: boolean;
    };
    const [rule] = await db.update(routingRules).set(body).where(eq(routingRules.id, id)).returning();
    if (!rule) return reply.code(404).send({ error: "not found" });
    return rule;
  });

  app.delete("/routing-rules/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [rule] = await db.delete(routingRules).where(eq(routingRules.id, id)).returning();
    if (!rule) return reply.code(404).send({ error: "not found" });
    return reply.code(204).send();
  });

  app.get("/labels", async () => db.select().from(labels).orderBy(labels.name));

  app.post("/labels", async (req, reply) => {
    const body = req.body as { name?: string; color?: string };
    if (!body.name) throw badRequest("name is required");
    const [label] = await db.insert(labels).values({ name: body.name, color: body.color }).returning();
    reply.code(201);
    return label;
  });

  app.post("/tasks/:id/labels", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { labelId?: number };
    if (!body.labelId) throw badRequest("labelId is required");
    // labelling a task that is already queued would put it in the
    // queue as root work without a grant. Label it first, then grant.
    const [label] = await db.select().from(labels).where(eq(labels.id, body.labelId));
    if (label?.name === ROOT_LABEL) {
      const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
      if (task?.status === "queued" && !grantState(task, new Date()).active) {
        return reply.code(409).send({ error: `a queued task cannot be labelled '${ROOT_LABEL}'; move it out of the queue, label it, then grant it` });
      }
    }
    await db.insert(taskLabels).values({ taskId: id, labelId: body.labelId }).onConflictDoNothing();
    const actor = actorFromRequest(req);
    await recordEvent(id, "label_added", actor.actorType, actor.actorName, { labelId: body.labelId });
    reply.code(204);
  });

  app.delete("/tasks/:id/labels/:labelId", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const labelId = Number((req.params as { labelId: string }).labelId);
    await db.delete(taskLabels).where(and(eq(taskLabels.taskId, id), eq(taskLabels.labelId, labelId)));
    const actor = actorFromRequest(req);
    await recordEvent(id, "label_removed", actor.actorType, actor.actorName, { labelId });
    reply.code(204);
  });

  // A past task: root grants - see root-grants.ts. GET is what homelab's
  // rootproxy asks before every call on the Proxmox host.
  app.get("/tasks/:id/root-grant", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!task) return reply.code(404).send({ error: "not found" });
    return { taskId: id, ...grantState(task, new Date()) };
  });

  // The operator's approval: records a grant for the task's current root
  // scope and queues it, in one step, so there is no window where a queued
  // root task has no grant or a granted one is not queued.
  app.post("/tasks/:id/root-grant", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const operator = checkOperatorRequest(req.headers, config.rootGrants);
    if (!operator.ok) return reply.code(403).send({ error: operator.reason });
    const ttl = validateTtlHours((req.body as { ttlHours?: unknown } | undefined)?.ttlHours);
    if (!ttl.ok) throw badRequest(ttl.reason);

    const [before] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!before) return reply.code(404).send({ error: "not found" });
    const grantable = checkGrantable(before, await hasRootLabel(id));
    if (!grantable.ok) return reply.code(409).send({ error: grantable.reason });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl.hours * 3600_000);
    const actor = actorFromRequest(req);
    const grantedBy = `${actor.actorName} (${operator.clientIp})`;
    // Same requeue semantics as a PATCH to `queued`: a fresh attempt budget,
    // and repair evidence kept only when coming back out of `rework`.
    const keepRepair = keepRepairOnPatch(before.status, "queued");
    const [task] = await db
      .update(tasks)
      .set({
        status: "queued",
        attemptCount: before.status === "queued" ? before.attemptCount : 0,
        ...(keepRepair ? {} : { repairReason: null, repairContext: null }),
        rootGrantCtids: before.rootScope,
        rootGrantExpiresAt: expiresAt,
        rootGrantedAt: now,
        rootGrantedBy: grantedBy,
        updatedAt: now,
      })
      .where(eq(tasks.id, id))
      .returning();
    if (before.status !== "queued") {
      await recordEvent(id, "status", actor.actorType, actor.actorName, { from: before.status, to: "queued", reason: "root grant" });
    }
    await recordEvent(id, "root_granted", actor.actorType, actor.actorName, {
      ctids: before.rootScope,
      expiresAt: expiresAt.toISOString(),
      clientIp: operator.clientIp,
    });
    return { ...task, rootGrant: grantState(task, now) };
  });

  // Anyone may revoke: taking root away is never the dangerous direction.
  // The task keeps its status; an agent run already going loses rootproxy
  // access on its next call.
  app.delete("/tasks/:id/root-grant", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [task] = await db
      .update(tasks)
      .set({ rootGrantExpiresAt: revokeGrantSql, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    if (!task) return reply.code(404).send({ error: "not found" });
    const actor = actorFromRequest(req);
    await recordEvent(id, "root_revoked", actor.actorType, actor.actorName);
    return { taskId: id, ...grantState(task, new Date()) };
  });

  // PLAN.md's I5: budget/burn-rate view. costUsd lives on `handoffs`, not
  // `tasks` (see usage.ts), so this is aggregation rather than a plain list.
  app.get("/usage/summary", async () => getUsageSummary());

  // spend reported by an interactive Claude Code session (a session-end
  // hook), recorded for calibration and the usage view but never counted
  // toward the budget gate - see usage.ts's UNGATED_USAGE_SOURCES. The same
  // (sessionId, costUsd) within a minute is stored once (InteractiveDedupe).
  app.post(
    "/usage",
    {
      schema: {
        body: {
          type: "object",
          required: ["costUsd", "source", "linuxUser", "sessionId"],
          additionalProperties: false,
          properties: {
            costUsd: { type: "number", exclusiveMinimum: 0 },
            source: { type: "string", enum: ["interactive"] },
            linuxUser: { type: "string", minLength: 1 },
            sessionId: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { costUsd: number; source: "interactive"; linuxUser: string; sessionId: string };
      const licenseRows = await db.select({ id: licenses.id, linuxUser: licenses.linuxUser }).from(licenses);
      const licenseId = licenseIdForLinuxUser(licenseRows, body.linuxUser);
      if (licenseId === null) throw badRequest(`no license runs as linux user '${body.linuxUser}'`);
      const seen = interactiveDedupe.check(body.sessionId, body.costUsd);
      if (seen.duplicate) return reply.code(200).send({ id: seen.id, duplicate: true });
      let id: number | null;
      try {
        id = await recordUsageEvent({ costUsd: body.costUsd, source: body.source, licenseId });
      } catch (err) {
        interactiveDedupe.forget(body.sessionId, body.costUsd);
        throw err;
      }
      interactiveDedupe.remember(body.sessionId, body.costUsd, id);
      return reply.code(201).send({ id, duplicate: false });
    },
  );

  // cost per task, rolled up per project and per parent project.
  app.get("/usage/rollup", async () => getCostRollup());

  // operator-configurable weekly reset point (e.g. Friday 16:00),
  // used to scope "since reset" usage instead of a fixed calendar week - see
  // settings.ts.
  app.get("/settings/weekly-reset", async () => getWeeklyResetSetting());

  app.put("/settings/weekly-reset", async (req, reply) => {
    const body = req.body as { dayOfWeek?: unknown; hour?: unknown };
    let dayOfWeek: number;
    let hour: number;
    try {
      dayOfWeek = validateDayOfWeek(body.dayOfWeek);
      hour = validateHour(body.hour);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    const setting = await updateWeeklyResetSetting(dayOfWeek, hour);
    reply.code(200);
    return setting;
  });

  // Manual trigger for the same digest the daily schedule sends (index.ts) -
  // lets the operator verify mail delivery without waiting for 09:00, and
  // gives a real signal (sent: false + reason) when SMTP isn't configured
  // yet rather than silently doing nothing.
  app.post("/usage/digest/send", async () => runDailyDigest());

  // PLAN.md's I6 governor - see governor.ts for the full model. Observations
  // are manually entered (Claude's own UI has no API, only a whole-number %
  // for the operator to read and punch in), so there's no actor requirement
  // here the way task writes have - this isn't agent/human provenance, it's
  // a single operator's own allowance reading.
  app.post("/governor/observations", async (req, reply) => {
    const body = req.body as { scope?: unknown; percentRemaining?: unknown; note?: string };
    let scope: Scope;
    let percentRemaining: number;
    try {
      scope = validateScope(body.scope);
      percentRemaining = validatePercent(body.percentRemaining);
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    const observation = await recordObservation(scope, percentRemaining, body.note);
    reply.code(201);
    return observation;
  });

  app.get("/governor/observations", async (req) => {
    const q = req.query as { scope?: string; limit?: string };
    let scope: Scope | undefined;
    try {
      scope = q.scope ? validateScope(q.scope) : undefined;
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    return listObservations(scope, q.limit ? Number(q.limit) : undefined);
  });

  app.get("/governor/status", async () => getGovernorStatus());

  // I16: operator-entered $-to-% rate(s), effective-dated - see governor.ts's
  // BudgetRate note for why this isn't a mutable settings row.
  app.post("/governor/rates", async (req, reply) => {
    const body = req.body as {
      usdPerSessionPercent?: unknown;
      usdPerWeekPercent?: unknown;
      effectiveFrom?: string;
      note?: string;
    };
    let usdPerSessionPercent: number;
    let usdPerWeekPercent: number;
    try {
      usdPerSessionPercent = validateRate(body.usdPerSessionPercent, "usdPerSessionPercent");
      usdPerWeekPercent = validateRate(body.usdPerWeekPercent, "usdPerWeekPercent");
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : undefined;
    const rate = await recordBudgetRate(usdPerSessionPercent, usdPerWeekPercent, effectiveFrom, body.note);
    reply.code(201);
    return rate;
  });

  app.get("/governor/rates", async (req) => {
    const q = req.query as { limit?: string };
    return listBudgetRates(q.limit ? Number(q.limit) : undefined);
  });

  // plain date+rate log of every rate change, for charting drift
  // over time - see governor.ts's budgetRateHistory note.
  app.get("/governor/rate-history", async (req) => {
    const q = req.query as { limit?: string };
    return listBudgetRateHistory(q.limit ? Number(q.limit) : undefined);
  });

  // PLAN.md's I8: planning chat passthrough. awaitingAgent flips on a human
  // message and back off on an agent one, which is what foreman's poller
  // (never reachable the other way) watches for - see foreman's chat.ts.
  // I9 reuses the same table for task-scoped session chat, distinguished by
  // taskId - taskId=none (IS NULL) is how foreman's I8 poller and the PWA's
  // general /chat list both exclude those from planning-chat handling.
  app.get("/chat/threads", async (req) => {
    const q = req.query as { projectId?: string; taskId?: string; status?: string; awaitingAgent?: string };
    const conditions = [];
    if (q.projectId) conditions.push(eq(chatThreads.projectId, Number(q.projectId)));
    if (q.taskId === "none") conditions.push(isNull(chatThreads.taskId));
    else if (q.taskId !== undefined) conditions.push(eq(chatThreads.taskId, Number(q.taskId)));
    if (q.status) conditions.push(eq(chatThreads.status, q.status));
    if (q.awaitingAgent !== undefined) conditions.push(eq(chatThreads.awaitingAgent, q.awaitingAgent === "true"));

    return db
      .select()
      .from(chatThreads)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(chatThreads.updatedAt));
  });

  const CHAT_MODELS = ["sonnet", "opus"];
  const CHAT_EFFORTS = ["medium", "high"];

  app.post("/chat/threads", async (req, reply) => {
    const body = req.body as {
      projectId?: number;
      taskId?: number;
      agentId?: number;
      title?: string;
      model?: string;
      effort?: string;
    };
    if (!body.title) throw badRequest("title is required");
    if (body.agentId !== undefined) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, body.agentId));
      if (!agent) throw badRequest(`no agent with id ${body.agentId}`);
    }
    if (body.model !== undefined && !CHAT_MODELS.includes(body.model)) {
      throw badRequest(`model must be one of: ${CHAT_MODELS.join(", ")}`);
    }
    if (body.effort !== undefined && !CHAT_EFFORTS.includes(body.effort)) {
      throw badRequest(`effort must be one of: ${CHAT_EFFORTS.join(", ")}`);
    }
    const [thread] = await db
      .insert(chatThreads)
      .values({
        projectId: body.projectId,
        taskId: body.taskId,
        agentId: body.agentId,
        title: body.title,
        model: body.model,
        effort: body.effort,
      })
      .returning();
    await recordJournalEvent({
      taskId: thread.taskId,
      projectId: thread.projectId,
      eventType: "chat_thread_created",
      ...actorFromRequest(req),
      payload: { threadId: thread.id, title: thread.title },
    });
    reply.code(201);
    return thread;
  });

  app.get("/chat/threads/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });
    return thread;
  });

  app.patch("/chat/threads/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as Record<string, unknown>;
    const [thread] = await db
      .update(chatThreads)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(chatThreads.id, id))
      .returning();
    if (!thread) return reply.code(404).send({ error: "not found" });
    // a thread closing, or its agent/model being changed
    // mid-conversation, is something a live session needs to act on (tear
    // itself down, restart with the new model) rather than discover later.
    publishChat({ threadId: id, event: "thread_updated", data: thread });
    return thread;
  });

  app.get("/chat/threads/:id/messages", async (req) => {
    const id = Number((req.params as { id: string }).id);
    return db.select().from(chatMessages).where(eq(chatMessages.threadId, id)).orderBy(chatMessages.createdAt);
  });

  // A human message hands the turn to the agent; an agent reply hands it
  // back - awaitingAgent is entirely a function of who spoke last, so
  // there's nowhere else in the API this needs to be set explicitly.
  app.post("/chat/threads/:id/messages", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { role?: string; body?: string };
    if (body.role !== "human" && body.role !== "agent") throw badRequest("role must be 'human' or 'agent'");
    if (!body.body) throw badRequest("body is required");

    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });

    const [message] = await db
      .insert(chatMessages)
      .values({ threadId: id, role: body.role, body: body.body })
      .returning();
    await db
      .update(chatThreads)
      .set({ awaitingAgent: body.role === "human", updatedAt: new Date() })
      .where(eq(chatThreads.id, id));
    // a human message is what a live session on foreman is
    // waiting for - either as the next thing to work on, or as the reply to
    // a permission request it is blocked inside. Published so it arrives on
    // foreman's SSE subscription immediately instead of on its next poll;
    // the poller still exists and still works, so a dropped notification
    // costs latency, not the message.
    if (body.role === "human") publishChat({ threadId: id, event: "human_message", data: message });
    // an agent writing into a task's own thread is a run asking
    // the operator something (I9's `work task ask`) - that needs attention.
    // Replies on a free-standing chat thread do not: the operator started
    // that conversation and is presumably watching it.
    if (body.role === "agent" && thread.taskId !== null) {
      await recordJournalEvent({
        taskId: thread.taskId,
        eventType: "chat_question",
        actorType: "agent",
        actorName: "chat",
        payload: { threadId: id, preview: body.body.slice(0, 200) },
      });
    }
    reply.code(201);
    return message;
  });

  // a chat thread's own usage bucket, accumulated turn by turn -
  // separate from /tasks/:id/handoff, which is keyed to a task and updates
  // task-specific fields (status, actualCostUsd) that don't apply here.
  // foreman calls this once per turn with that turn's own cost/duration
  // (from `claude -p --output-format json`'s own usage fields), the same
  // add-not-overwrite accumulation the task handoff endpoint uses.
  app.post("/chat/threads/:id/usage", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { costUsd?: number | string; durationMs?: number };

    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });

    // resolve the license the same way the handoff route does -
    // from the thread's own agent when it has one, else the default license.
    let licenseId: number | null = null;
    if (thread.agentId) {
      const [agent] = await db.select({ licenseId: agents.licenseId }).from(agents).where(eq(agents.id, thread.agentId));
      licenseId = agent?.licenseId ?? null;
    }
    licenseId ??= await getDefaultLicenseId();

    const addedCostUsd = Number(body.costUsd ?? 0);
    const addedDurationMs = Number(body.durationMs ?? 0);
    const [updated] = await db
      .update(chatThreads)
      .set({
        totalCostUsd: (Number(thread.totalCostUsd) + addedCostUsd).toFixed(4),
        totalDurationMs: thread.totalDurationMs + addedDurationMs,
        updatedAt: new Date(),
      })
      .where(eq(chatThreads.id, id))
      .returning();
    // chat spend is real money against the same 5h window a task
    // run is charged to, but chatThreads only carries a running total with no
    // per-turn history - so each turn's own delta is appended here as it
    // happens. Without this, session windows would silently under-count every
    // planning conversation.
    await recordUsageEvent({ costUsd: addedCostUsd, source: "chat", licenseId, chatThreadId: id, taskId: thread.taskId });
    return updated;
  });

  // ---------------------------------------------------------------------
  // live chat sessions - transcript events, persisted permission
  // rules, and the two SSE streams that replace polling on both sides.
  // Nothing user-visible changes until foreman (#148) and the PWA (#149)
  // land; these routes are inert until something calls them.
  // ---------------------------------------------------------------------

  // foreman posts a batch, not one request per delta - a live turn emits
  // hundreds of text deltas and a request each would cost more in HTTP than
  // in inference. Every insert also trims the thread back to its cap, so
  // retention needs no scheduler (see chat-events.ts).
  app.post("/chat/threads/:id/events", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });

    let normalized;
    try {
      normalized = normalizeEventBatch(req.body);
    } catch (err) {
      if (err instanceof ChatEventError) throw badRequest(err.message);
      throw err;
    }

    const inserted = await db
      .insert(chatEvents)
      .values(normalized.map((event) => ({ threadId: id, ...event })))
      .returning();

    // Trim by id rather than by createdAt: several events in one batch share
    // a millisecond, and a timestamp cut would drop an arbitrary subset of
    // them. Kept in one statement so a concurrent batch can't interleave a
    // read-then-delete.
    // `returning id` so the count reported back is the number actually
    // deleted rather than a guess - foreman logs it, and a silently-wrong
    // zero would hide retention failing.
    const trimmed = await db.execute(sqlRaw`
      delete from chat_events
      where thread_id = ${id}
        and id <= coalesce(
          (select id from chat_events where thread_id = ${id} order by id desc offset ${EVENTS_PER_THREAD_CAP} limit 1),
          -1
        )
      returning id
    `);

    // Deliver to anyone watching this thread. Subscribers also replay from
    // the table on connect, so a subscriber that missed this notification
    // (attached a millisecond later, say) still sees the event - the bus is
    // latency, not delivery.
    for (const event of inserted) publishChat({ threadId: id, event: "chat_event", data: event });
    for (const event of inserted) {
      const p = (event.payload ?? {}) as Record<string, unknown>;
      if (event.kind === "permission_request") {
        await recordJournalEvent({
          taskId: thread.taskId,
          projectId: thread.projectId,
          eventType: "chat_permission_request",
          actorType: "agent",
          actorName: "chat",
          payload: { threadId: id, threadTitle: thread.title, toolName: typeof p.toolName === "string" ? p.toolName : undefined },
        });
        continue;
      }
      // a question needs a notification for the same reason a
      // permission request does - the session is blocked on the operator and
      // nothing else says so. `chat_question` already exists as an event type
      // (I9's `work task ask`) and derives an "Agent is asking a question"
      // notification from exactly these two payload fields.
      if (event.kind === "question") {
        const first = Array.isArray(p.questions) ? (p.questions[0] as Record<string, unknown> | undefined) : undefined;
        await recordJournalEvent({
          taskId: thread.taskId,
          projectId: thread.projectId,
          eventType: "chat_question",
          actorType: "agent",
          actorName: "chat",
          payload: {
            threadId: id,
            preview: typeof first?.question === "string" ? first.question.slice(0, 200) : thread.title,
          },
        });
      }
    }

    reply.code(201);
    return { inserted: inserted.length, trimmed: trimmed.length ?? 0 };
  });

  // Replay, so reloading the page mid-turn doesn't lose the transcript -
  // the PWA asks for everything since the last id it has and then follows
  // the stream from there.
  app.get("/chat/threads/:id/events", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { since?: string; limit?: string; turn?: string };
    const conditions = [eq(chatEvents.threadId, id)];
    if (q.since !== undefined) conditions.push(gt(chatEvents.id, Number(q.since)));
    if (q.turn !== undefined) conditions.push(eq(chatEvents.turn, Number(q.turn)));
    const limit = Math.min(Number(q.limit ?? 500), EVENTS_PER_THREAD_CAP);

    // Without a `since` this is an initial load, and an initial load wants the
    // *newest* events - the live tip - not the oldest. Ascending-plus-limit
    // returned the front of a long transcript and left the caller pinned
    // there: its next `?since=` starts from that stale high-water mark, so a
    // thread holding more than `limit` events could never walk forward to what
    // is happening now, and a pending permission request or a running turn
    // simply never rendered. Found reviewing a past task, the first consumer
    // this route ever had. Taken descending and reversed, so the response is
    // oldest-first either way and callers don't have to care which end it came
    // from.
    if (q.since === undefined) {
      const newest = await db
        .select()
        .from(chatEvents)
        .where(and(...conditions))
        .orderBy(desc(chatEvents.id))
        .limit(limit);
      return newest.reverse();
    }

    return db
      .select()
      .from(chatEvents)
      .where(and(...conditions))
      .orderBy(chatEvents.id)
      .limit(limit);
  });

  // What "don't ask again" granted. Stored in the Agent SDK's own rule shape
  // and handed back to it verbatim - pinboard never matches a rule against a
  // tool call itself, see schema.ts's note on chatPermissionRules.
  app.get("/chat/threads/:id/permission-rules", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as { turn?: string; includeRevoked?: string };
    const rules = await db
      .select()
      .from(chatPermissionRules)
      .where(eq(chatPermissionRules.threadId, id))
      .orderBy(chatPermissionRules.id);
    if (q.includeRevoked === "true") return rules;
    return activeRulesForTurn(rules, q.turn === undefined ? null : Number(q.turn));
  });

  app.post("/chat/threads/:id/permission-rules", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });

    let rule;
    try {
      rule = normalizePermissionRule(req.body);
    } catch (err) {
      if (err instanceof ChatEventError) throw badRequest(err.message);
      throw err;
    }
    const [created] = await db
      .insert(chatPermissionRules)
      .values({ threadId: id, ...rule })
      .returning();
    publishChat({ threadId: id, event: "permission_rule", data: created });
    reply.code(201);
    return created;
  });

  // Revoked, not deleted - the record of what was approved and when is the
  // point of persisting these at all.
  app.delete("/chat/threads/:id/permission-rules/:ruleId", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const ruleId = Number((req.params as { ruleId: string }).ruleId);
    const [revoked] = await db
      .update(chatPermissionRules)
      .set({ revokedAt: new Date() })
      .where(and(eq(chatPermissionRules.id, ruleId), eq(chatPermissionRules.threadId, id)))
      .returning();
    if (!revoked) return reply.code(404).send({ error: "not found" });
    publishChat({ threadId: id, event: "permission_rule", data: revoked });
    return revoked;
  });

  // the operator's answer to a `permission_request`. A live
  // session is blocked inside the SDK's canUseTool waiting for exactly this,
  // keyed by `requestId` - which is why this is its own route and not a chat
  // message. permission-server.ts had to infer the answer from "the most
  // recent human message after the question", which cannot tell two
  // concurrent requests apart and has nowhere to carry a rule.
  //
  // Delivered on the stream rather than left to be polled: the session is
  // holding a tool call open, so latency here is the operator watching a
  // spinner. Also written to the transcript, so what was approved (and what
  // it granted) is recoverable after the fact.
  app.post("/chat/threads/:id/permission-decision", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });

    let decision;
    try {
      decision = normalizePermissionDecision(req.body);
    } catch (err) {
      if (err instanceof ChatEventError) throw badRequest(err.message);
      throw err;
    }

    const [event] = await db
      .insert(chatEvents)
      .values({ threadId: id, kind: "permission_decision", payload: decision })
      .returning();
    publishChat({ threadId: id, event: "permission_decision", data: { threadId: id, ...decision } });
    await recordJournalEvent({
      taskId: thread.taskId,
      projectId: thread.projectId,
      eventType: "chat_permission_decision",
      ...actorFromRequest(req),
      payload: { threadId: id, decision: decision.behavior },
    });
    publishChat({ threadId: id, event: "chat_event", data: event });

    reply.code(201);
    return { ...decision, delivered: subscriberCount() };
  });

  // the operator's answer to a `question` event. Deliberately a
  // separate route from permission-decision rather than a reuse of it: an
  // approval is allow/deny plus SDK permission updates pinboard passes
  // through opaquely, while this is free-form text that ends up inside the
  // tool's own input and therefore has to be validated as strings here.
  //
  // Delivered on the stream for the same reason: a tool call is parked on
  // this answer, so latency here is the operator watching a spinner.
  app.post("/chat/threads/:id/question-answer", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });

    let answer;
    try {
      answer = normalizeQuestionAnswer(req.body);
    } catch (err) {
      if (err instanceof ChatEventError) throw badRequest(err.message);
      throw err;
    }

    // One answer per question, and the first one wins. Two ways this matters,
    // both of which put a wrong transcript in front of the operator rather
    // than merely wasting a write. foreman writes its own `question_answer`
    // when its wait times out, and a reply that lands after that is never
    // delivered to the tool call - it already ran with no answers - so
    // recording it would show real-looking answers for a question the agent
    // provably did not have. And a double submit (two tabs, an impatient
    // second tap) would silently change which answer set the transcript
    // shows as the one that was used.
    const [already] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.threadId, id),
          eq(chatEvents.kind, "question_answer"),
          sqlRaw`${chatEvents.payload}->>'requestId' = ${answer.requestId}`,
        ),
      )
      .limit(1);
    if (already) {
      return reply.code(409).send({ error: "this question has already been answered, or it timed out" });
    }

    const [event] = await db
      .insert(chatEvents)
      .values({ threadId: id, kind: "question_answer", payload: { ...answer, answered: true } })
      .returning();
    publishChat({ threadId: id, event: "question_answer", data: { threadId: id, ...answer } });
    publishChat({ threadId: id, event: "chat_event", data: event });

    reply.code(201);
    return { ...answer, delivered: subscriberCount() };
  });

  // the operator's stop button (the PWA half is #149). There is a
  // live session to interrupt now rather than a process to kill, so this is
  // a signal on the stream, not a PATCH foreman discovers on its next poll -
  // a stop that arrives 2s late has already let the tool call it was meant
  // to stop run.
  app.post("/chat/threads/:id/interrupt", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const [thread] = await db.select().from(chatThreads).where(eq(chatThreads.id, id));
    if (!thread) return reply.code(404).send({ error: "not found" });
    publishChat({ threadId: id, event: "interrupt", data: { threadId: id } });
    // Recorded on the transcript too: an interrupted turn otherwise just
    // stops, with nothing saying whether it finished or was stopped.
    await db.insert(chatEvents).values({ threadId: id, kind: "error", payload: { interrupted: true, by: "operator" } });
    return { ok: true, delivered: subscriberCount() };
  });

  // Shared by both SSE endpoints below. Fastify's reply.raw is used directly
  // rather than returning a stream: the connection stays open indefinitely
  // and is written to from the bus, which is not a shape `return`ing a value
  // expresses. Heartbeat comments keep intermediaries (Caddy, the tailnet)
  // from treating a quiet connection as dead, and give the client a way to
  // notice a half-open socket.
  function openSseStream(
    req: FastifyRequest,
    reply: FastifyReply,
    filter: (message: ChatBusMessage) => boolean,
  ): void {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Belt and braces for any proxy that buffers by default; Caddy already
      // streams text/event-stream unbuffered.
      "x-accel-buffering": "no",
    });
    reply.raw.write(": connected\n\n");

    const unsubscribe = subscribeChat((message) => {
      if (!filter(message)) return;
      try {
        reply.raw.write(formatSseFrame(message.event, message.data));
      } catch {
        // A write to a socket the client already dropped must not take the
        // publisher down with it - close handling below does the cleanup.
      }
    });
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        /* same */
      }
    }, SSE_HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  }

  // foreman's own subscription: it opens this outbound and holds it, so a
  // human message or a permission reply reaches the live session in under a
  // second. No inbound path to that LXC is created by this - the connection
  // is always foreman's to open, exactly as its polling loop was.
  app.get("/chat/stream", async (req, reply) => {
    const q = req.query as { threadId?: string };
    const threadId = q.threadId === undefined ? null : Number(q.threadId);
    openSseStream(req, reply, (message) => {
      if (threadId !== null && message.threadId !== threadId) return false;
      // foreman has no use for its own transcript echoed back at it; it
      // wants the things it cannot see from inside its own session.
      return isForemanStreamEvent(message.event);
    });
    return reply;
  });

  // The PWA's subscription for one thread - everything that concerns it,
  // transcript included.
  app.get("/chat/threads/:id/stream", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    openSseStream(req, reply, (message) => message.threadId === id);
    return reply;
  });

  // the work plan - see plan.ts. Recomputed on every read rather
  // than stored: it is a forecast off live tasks/budget/usage, and a stored
  // plan would be stale the moment any of the three moved.
  // GET /plan is the human-facing Plan screen - ?licenseId=
  // defaults to the "default" license (the 0024 migration's backfill target)
  // so the existing PWA keeps working without a license picker of its own.
  // /plan/next and /plan/gate/:taskId are foreman's own dispatch-loop calls,
  // each with a specific license's dispatcher behind it, so licenseId is
  // required there instead of defaulted.
  app.get("/plan", async (req) => {
    const q = req.query as { licenseId?: string };
    const licenseId = q.licenseId ? Number(q.licenseId) : await getDefaultLicenseId();
    return getPlan(licenseId);
  });

  // The dispatcher-facing slice foreman polls - just "what may start now",
  // plus a waitUntil when the right move is to sleep rather than re-ask.
  // ?override=true is the operator's explicit "run it anyway": it skips the
  // budget gates only, never concurrency or the repo-conflict rule.
  //
  // ?licenseId= defaults to the "default" license rather than
  // being hard-required - foreman (a past task, not built yet as of this
  // writing) is the only caller and polls this every 60s in production;
  // hard-requiring it here before #151 ships would 400 every poll and halt
  // all autonomous dispatch. #151 should pass a real licenseId once its
  // dispatch loop is per-license.
  app.get("/plan/next", async (req) => {
    const q = req.query as { licenseId?: string; override?: string };
    const licenseId = q.licenseId ? Number(q.licenseId) : await getDefaultLicenseId();
    return getPlanNext(licenseId, new Date(), q.override === "true");
  });

  // "may this specific task start now?" - what foreman's direct
  // `work task run <id>` path asks, as opposed to /plan/next's "pick me
  // something". Same rules, evaluated with this task as the sole candidate.
  // See /plan/next above on why licenseId defaults rather than being required.
  app.get("/plan/gate/:taskId", async (req) => {
    const taskId = Number((req.params as { taskId: string }).taskId);
    if (!Number.isInteger(taskId)) throw badRequest("taskId must be an integer");
    const q = req.query as { licenseId?: string; override?: string };
    const licenseId = q.licenseId ? Number(q.licenseId) : await getDefaultLicenseId();
    return getPlanGate(taskId, licenseId, new Date(), q.override === "true");
  });

  // foreman reports a session-limit wall here after parsing it out
  // of a failed run's error text. This is the only ground truth pinboard ever
  // gets about where Claude actually drew the 5h boundary - there is no API
  // for it, and deriving it from spend (session-windows.ts) is an inference
  // that is wrong in exactly the expensive direction: it can believe a window
  // has expired while the real one is still running, and then hand out task
  // after task into a wall. See tasks #117 and #115 on 2026-09-16.
  app.post("/plan/session-limit", async (req, reply) => {
    const body = req.body as { resetsAt?: string; licenseId?: number; taskId?: number; rawError?: string };
    if (!body.resetsAt) throw badRequest("resetsAt is required");
    const resetsAt = new Date(body.resetsAt);
    if (Number.isNaN(resetsAt.getTime())) throw badRequest("resetsAt must be an ISO timestamp");
    const licenseId = body.licenseId ?? (await getDefaultLicenseId());
    const [row] = await db
      .insert(sessionLimitReports)
      .values({ resetsAt, licenseId, taskId: body.taskId ?? null, rawError: body.rawError ?? null })
      .returning();
    reply.code(201);
    return row;
  });

  // The operator's "the window isn't really spent" override. The derived
  // window is only an estimate from pinboard's own cost figures, and when it
  // disagrees with Claude's real limit the seat idles for hours. This makes the
  // planner forget session spend (and session-limit reports) up to now; if
  // the window really was spent, the next run hits Claude's limit, foreman
  // reports it, and that report blocks the seat until the real reset.
  app.post("/plan/session-reset", async (req, reply) => {
    const body = (req.body ?? {}) as { licenseId?: number };
    const licenseId = body.licenseId ?? (await getDefaultLicenseId());
    const license = await resetSessionWindow(licenseId);
    if (!license) return reply.code(404).send({ error: "license not found" });
    return license;
  });

  // The currently-live report for a license, or null. Mostly a diagnostic -
  // the plan already folds this in - but it makes "why is the dispatcher
  // asleep?" answerable with one call instead of a table read.
  app.get("/plan/session-limit", async (req) => {
    const q = req.query as { licenseId?: string };
    const licenseId = q.licenseId ? Number(q.licenseId) : await getDefaultLicenseId();
    const resetsAt = await liveSessionLimitReset(licenseId, new Date());
    return { licenseId, resetsAt: resetsAt ? resetsAt.toISOString() : null };
  });

  app.get("/plan/periods", async (req) => {
    const q = req.query as { limit?: string; licenseId?: string };
    return listBudgetPeriods(q.limit ? Number(q.limit) : undefined, q.licenseId ? Number(q.licenseId) : undefined);
  });

  app.get("/plan/periods/current", async (req, reply) => {
    const q = req.query as { licenseId?: string };
    const licenseId = q.licenseId ? Number(q.licenseId) : await getDefaultLicenseId();
    const period = await getCurrentBudgetPeriod(licenseId);
    if (!period) return reply.code(404).send({ error: "no budget period covers now" });
    return period;
  });

  app.post("/plan/periods", async (req, reply) => {
    const body = req.body as { budgetUsd?: unknown; endsAt?: string; startsAt?: string; note?: string; licenseId?: number };
    let budgetUsd: number;
    try {
      budgetUsd = validatePositiveNumber(body.budgetUsd, "budgetUsd");
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    if (!body.endsAt) throw badRequest("endsAt is required");
    const endsAt = new Date(body.endsAt);
    if (Number.isNaN(endsAt.getTime())) throw badRequest("endsAt must be a valid ISO timestamp");
    const startsAt = body.startsAt ? new Date(body.startsAt) : undefined;
    if (startsAt && Number.isNaN(startsAt.getTime())) throw badRequest("startsAt must be a valid ISO timestamp");
    if (startsAt && startsAt >= endsAt) throw badRequest("startsAt must be before endsAt");
    // budget_periods.licenseId is a required FK now - default to
    // the "default" license so an existing caller that doesn't yet know about
    // licenses (the current PWA) keeps working unchanged.
    const licenseId = body.licenseId ?? (await getDefaultLicenseId());
    const period = await createBudgetPeriod(budgetUsd, endsAt, licenseId, startsAt, body.note);
    reply.code(201);
    return period;
  });

  app.patch("/plan/periods/:id", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = req.body as { budgetUsd?: unknown; endsAt?: string; startsAt?: string; note?: string | null };
    const patch: { budgetUsd?: number; endsAt?: Date; startsAt?: Date; note?: string | null } = {};
    try {
      if (body.budgetUsd !== undefined) patch.budgetUsd = validatePositiveNumber(body.budgetUsd, "budgetUsd");
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    for (const field of ["endsAt", "startsAt"] as const) {
      const raw = body[field];
      if (raw === undefined) continue;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} must be a valid ISO timestamp`);
      patch[field] = parsed;
    }
    if (body.note !== undefined) patch.note = body.note;
    const period = await updateBudgetPeriod(id, patch);
    if (!period) return reply.code(404).send({ error: "not found" });
    return period;
  });

  app.get("/settings/planner", async () => getPlannerSettings());

  app.put("/settings/planner", async (req) => {
    const body = req.body as {
      sessionBudgetUsd?: unknown;
      defaultTaskCostUsd?: unknown;
      concurrencyGlobal?: unknown;
      useEffortScaling?: unknown;
    };
    const patch: { sessionBudgetUsd?: number; defaultTaskCostUsd?: number; concurrencyGlobal?: number; useEffortScaling?: boolean } = {};
    try {
      if (body.sessionBudgetUsd !== undefined) {
        patch.sessionBudgetUsd = validatePositiveNumber(body.sessionBudgetUsd, "sessionBudgetUsd");
      }
      if (body.defaultTaskCostUsd !== undefined) {
        patch.defaultTaskCostUsd = validatePositiveNumber(body.defaultTaskCostUsd, "defaultTaskCostUsd");
      }
      if (body.concurrencyGlobal !== undefined) {
        patch.concurrencyGlobal = validatePositiveInteger(body.concurrencyGlobal, "concurrencyGlobal");
      }
      if (body.useEffortScaling !== undefined) {
        patch.useEffortScaling = validateBoolean(body.useEffortScaling, "useEffortScaling");
      }
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : String(err));
    }
    return updatePlannerSettings(patch);
  });
}
