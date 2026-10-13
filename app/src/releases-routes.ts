import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "./db/client.js";
import { deployRequests, deployTargets, projects } from "./db/schema.js";
import { recordEvent } from "./journal.js";
import { findProjectForRepo, parseReleaseBump, parseTargetReport, truncateRequestOutput } from "./releases.js";
import { actorFromRequest } from "./routes.js";

// the releases view. Pinboard holds no SSH keys or GitHub
// credentials, so everything here is reported to it: foreman's probe PUTs
// what is deployed where, deploy-service.sh POSTs each deploy it runs, and
// "Deploy now" only queues a request for foreman to pick up.

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

const ACTIVE_REQUEST_STATUSES = ["queued", "running"];

export async function registerReleaseRoutes(app: FastifyInstance): Promise<void> {
  // Every project with a probed target or a deploy request, with its targets
  // and its latest request.
  app.get("/releases", async () => {
    const targets = await db.select().from(deployTargets).orderBy(asc(deployTargets.host), asc(deployTargets.app));
    const latestRequests = await db
      .selectDistinctOn([deployRequests.projectId])
      .from(deployRequests)
      .orderBy(deployRequests.projectId, desc(deployRequests.id));
    const ids = [...new Set([...targets.map((t) => t.projectId), ...latestRequests.map((r) => r.projectId)])];
    if (ids.length === 0) return [];
    const rows = await db
      .select({ id: projects.id, slug: projects.slug, name: projects.name, localPath: projects.localPath, archived: projects.archived })
      .from(projects)
      .where(inArray(projects.id, ids))
      .orderBy(asc(projects.name));
    return rows
      .filter((p) => !p.archived)
      .map((p) => ({
        ...p,
        targets: targets.filter((t) => t.projectId === p.id),
        lastRequest: latestRequests.find((r) => r.projectId === p.id) ?? null,
      }));
  });

  // foreman's probe: the full set of targets for one project, replacing
  // whatever was there.
  app.put("/releases/targets/:projectId", async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId);
    let report;
    try {
      report = parseTargetReport(req.body);
    } catch (err) {
      throw httpError(400, err instanceof Error ? err.message : String(err));
    }
    const [project] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw httpError(404, `project ${projectId} not found`);
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(deployTargets).where(eq(deployTargets.projectId, projectId));
      if (report.length) await tx.insert(deployTargets).values(report.map((t) => ({ ...t, projectId, checkedAt: now })));
    });
    reply.code(204);
  });

  // One deploy-service.sh step finishing, successfully or not. Journaled as
  // "deploy"; a success also moves the target's deployed sha straight away
  // instead of waiting for the next probe.
  app.post("/releases/deploys", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const repo = body.repo;
    const host = body.host;
    const outcome = body.outcome;
    if (typeof repo !== "string" || typeof host !== "string") throw httpError(400, "repo and host are required");
    if (outcome !== "succeeded" && outcome !== "failed") throw httpError(400, "outcome must be succeeded or failed");
    const app_ = typeof body.app === "string" ? body.app : "";
    const sha = typeof body.sha === "string" && body.sha !== "" ? body.sha : null;
    const taskId = typeof body.taskId === "number" ? body.taskId : null;
    const requestId = typeof body.requestId === "number" ? body.requestId : null;

    const all = await db.select({ id: projects.id, localPath: projects.localPath, archived: projects.archived }).from(projects);
    const project = findProjectForRepo(all, repo);

    await recordEvent({
      taskId,
      projectId: project?.id ?? null,
      eventType: "deploy",
      ...actorFromRequest(req),
      payload: { repo, host, app: app_ || null, sha, outcome, requestId, durationMs: body.durationMs ?? null },
    });

    if (project && outcome === "succeeded" && sha) {
      const where = and(eq(deployTargets.projectId, project.id), eq(deployTargets.host, host), eq(deployTargets.app, app_));
      const [target] = await db.select().from(deployTargets).where(where);
      if (target) {
        const current = target.mainSha === sha;
        await db
          .update(deployTargets)
          .set({
            deployedSha: sha,
            // Anything else is unknown until the next probe re-counts it.
            pendingCount: current ? 0 : null,
            pendingCommits: current ? [] : target.pendingCommits,
            probeError: null,
          })
          .where(where);
      }
    }
    reply.code(204);
  });

  // "Deploy now". One active request per project: a second click while one
  // is queued or running would only deploy the same thing twice.
  app.post("/releases/:projectId/deploy", async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw httpError(404, `project ${projectId} not found`);
    if (!project.localPath) throw httpError(400, `${project.slug} has no localPath, so there is no repo to deploy`);
    const [active] = await db
      .select({ id: deployRequests.id })
      .from(deployRequests)
      .where(and(eq(deployRequests.projectId, projectId), inArray(deployRequests.status, ACTIVE_REQUEST_STATUSES)));
    if (active) throw httpError(409, `deploy request #${active.id} for ${project.slug} is already in progress`);

    const actor = actorFromRequest(req);
    const [request] = await db
      .insert(deployRequests)
      .values({ projectId, requestedBy: `${actor.actorType}:${actor.actorName}` })
      .returning();
    await recordEvent({ projectId, eventType: "deploy_requested", ...actor, payload: { requestId: request.id } });
    reply.code(201);
    return request;
  });

  // "Release to production". Same one-active-request rule as
  // Deploy now, and only for a project whose probe reported a release target,
  // so a click can never ask foreman to release something with no declared
  // `release` block. foreman does the rest (version bump, branch push, image
  // build, tag bump, deploy) and reports the resulting version on finish.
  app.post("/releases/:projectId/release", async (req, reply) => {
    const projectId = Number((req.params as { projectId: string }).projectId);
    let bump;
    try {
      bump = parseReleaseBump(req.body);
    } catch (err) {
      throw httpError(400, err instanceof Error ? err.message : String(err));
    }
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) throw httpError(404, `project ${projectId} not found`);
    const [target] = await db
      .select({ id: deployTargets.id })
      .from(deployTargets)
      .where(and(eq(deployTargets.projectId, projectId), eq(deployTargets.release, true)));
    if (!target) throw httpError(400, `${project.slug} declares no production release`);
    const [active] = await db
      .select({ id: deployRequests.id })
      .from(deployRequests)
      .where(and(eq(deployRequests.projectId, projectId), inArray(deployRequests.status, ACTIVE_REQUEST_STATUSES)));
    if (active) throw httpError(409, `request #${active.id} for ${project.slug} is already in progress`);

    const actor = actorFromRequest(req);
    const [request] = await db
      .insert(deployRequests)
      .values({ projectId, kind: "release", bump, requestedBy: `${actor.actorType}:${actor.actorName}` })
      .returning();
    await recordEvent({ projectId, eventType: "release_requested", ...actor, payload: { requestId: request.id, bump } });
    reply.code(201);
    return request;
  });

  // foreman claims the oldest queued request. SKIP LOCKED so two pollers
  // can never take the same one.
  app.post("/releases/requests/claim", async (_req, reply) => {
    // A request left running by a foreman that died mid-deploy would block
    // its project's Deploy now forever. Nothing legitimate runs this long
    // (10 minutes of lock wait plus the deploy itself).
    await db.execute(sql`
      update deploy_requests set status = 'failed', finished_at = now(),
        output = coalesce(output, '') || 'Abandoned: still running after 45 minutes, foreman probably restarted mid-deploy.'
      where status = 'running' and kind = 'deploy' and started_at < now() - interval '45 minutes'`);
    // A release also waits for the image build, so it gets longer.
    await db.execute(sql`
      update deploy_requests set status = 'failed', finished_at = now(),
        output = coalesce(output, '') || 'Abandoned: still running after 90 minutes, foreman probably restarted mid-release. Check the app repo and the production compose file before releasing again.'
      where status = 'running' and kind = 'release' and started_at < now() - interval '90 minutes'`);
    const rows = await db.execute<{ id: number }>(sql`
      update deploy_requests set status = 'running', started_at = now()
      where id = (select id from deploy_requests where status = 'queued' order by id limit 1 for update skip locked)
      returning id`);
    const id = rows[0]?.id;
    if (id === undefined) {
      reply.code(204);
      return;
    }
    const [row] = await db
      .select({ request: deployRequests, localPath: projects.localPath, slug: projects.slug })
      .from(deployRequests)
      .innerJoin(projects, eq(projects.id, deployRequests.projectId))
      .where(eq(deployRequests.id, id));
    return { ...row.request, localPath: row.localPath, slug: row.slug };
  });

  app.post("/releases/requests/:id/finish", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { ok?: unknown; output?: unknown; version?: unknown };
    if (typeof body.ok !== "boolean") throw httpError(400, "ok must be a boolean");
    const version = typeof body.version === "string" && body.version !== "" ? body.version : undefined;
    const [updated] = await db
      .update(deployRequests)
      .set({
        status: body.ok ? "succeeded" : "failed",
        output: typeof body.output === "string" ? truncateRequestOutput(body.output) : null,
        ...(version ? { version } : {}),
        finishedAt: new Date(),
      })
      .where(and(eq(deployRequests.id, id), eq(deployRequests.status, "running")))
      .returning({ id: deployRequests.id });
    if (!updated) throw httpError(409, `deploy request ${id} is not running`);
    reply.code(204);
  });

  app.get("/releases/requests/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const [row] = await db.select().from(deployRequests).where(eq(deployRequests.id, id));
    if (!row) throw httpError(404, `deploy request ${id} not found`);
    return row;
  });
}
