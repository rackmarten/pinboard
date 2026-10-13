import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { projects, pullRequests, tasks } from "./db/schema.js";

// A past task. The post-PR pipeline: the steps between
// "the agent pushed a branch and opened a PR" and "a human looks at the
// result". None of them need an agent, so none of them should hold one - the
// session ends at the PR and a cheap foreman poller (#154's increment 2)
// drives the rest from these statuses alone.
//
// They are ordinary tasks.status values rather than a separate column so the
// governor's concurrency check (`status = 'executing'`) frees the agent slot
// for free - see schema.ts's comment on tasks.status.
export const PIPELINE_STATUSES = [
  // The PR is open and its branch's CI run is being polled.
  "awaiting_ci",
  // CI is green and the PR is ready to be squash-merged.
  "awaiting_merge",
  // Held for a human BEFORE merge, so main never carries an unreviewed
  // change of this kind - today that means a diff touching a drizzle
  // migration (#61's item 2), since a bad migration is far costlier to
  // unwind than a bad UI change. Which diffs qualify is the poller's call,
  // not this module's; from here it is just a stage a human releases.
  "awaiting_review",
  // Merged; deploy-service.sh is running against the repo's own LXC.
  "deploying",
  // Deployed; the repo's healthcheck.sh is being retried until it passes.
  "verifying",
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export function isPipelineStatus(status: string): status is PipelineStatus {
  return (PIPELINE_STATUSES as readonly string[]).includes(status);
}

// Why a stage handed the task back to `queued` for another agent run. A
// handback is not a status of its own - see schema.ts's comment on
// tasks.repairReason.
export const REPAIR_REASONS = ["ci_failed", "merge_conflict", "deploy_failed"] as const;
export type RepairReason = (typeof REPAIR_REASONS)[number];

export function isRepairReason(value: unknown): value is RepairReason {
  return (REPAIR_REASONS as readonly string[]).includes(value as string);
}

// Every legal move, in one place, so the poller cannot invent a state
// machine of its own and drift from what the UI shows. Read as "a task
// currently in X may be moved to any of Y":
//
//   executing/handoff -> awaiting_ci        the session ended at a PR
//   awaiting_ci       -> awaiting_merge     CI green, auto-deploy allowed
//                     -> awaiting_review    CI green, but held for a human
//                     -> review             CI green, nothing merges it (the
//                                           project has no auto-deploy opt-in,
//                                           so a human merges by hand)
//   awaiting_review   -> awaiting_merge     a human approved the hold
//   awaiting_merge    -> deploying          merged, the repo has an LXC
//                     -> review             merged, but nothing to deploy
//                                           (a library repo - see homelab/
//                                           AGENTS.md's "Repos with no LXC")
//   deploying         -> verifying          deploy script returned clean
//   verifying         -> review             healthcheck passed; a human now
//                                           signs the task off as usual
//                     -> done               healthcheck passed on an
//                                           executorMode=agent task, closed
//                                           without a human; same
//                                           side effects as /complete
//
// Plus, from every pipeline status: `queued` (hand back to an agent, with a
// repairReason) and `rework`/`rejected` (a human giving up on it or pulling
// it out of the pipeline by hand). The manual escape hatches matter because
// the poller can wedge - a CI run that never completes, an LXC that will not
// come back - and the operator needs a way out that does not mean editing the
// database.
const HANDBACK_TARGETS = ["queued", "rework", "rejected"] as const;

// A past task adds two families:
//   review            -> awaiting_merge     a human approved a task whose PR is
//                                           still open, so approving merges it
//                                           instead of closing it over an
//                                           unmerged branch
//   queued/executing/ -> needs_input        an agent asked a question nobody
//   handoff                                 answered; parked, not an attempt
//                                           (foreman posts the handoff first,
//                                           so a no-commit session ending on
//                                           a question moves from handoff)
//   needs_input       -> queued             the operator answered (no
//                                           repairReason - it is not a repair)
//                     -> rework/rejected
const TRANSITIONS: Record<string, readonly string[]> = {
  queued: ["needs_input"],
  executing: ["awaiting_ci", "needs_input"],
  needs_input: [...HANDBACK_TARGETS],
  review: ["awaiting_merge"],
  handoff: ["awaiting_ci", "needs_input"],
  awaiting_ci: ["awaiting_merge", "awaiting_review", "review", ...HANDBACK_TARGETS],
  awaiting_review: ["awaiting_merge", ...HANDBACK_TARGETS],
  awaiting_merge: ["deploying", "review", ...HANDBACK_TARGETS],
  deploying: ["verifying", ...HANDBACK_TARGETS],
  verifying: ["review", "done", ...HANDBACK_TARGETS],
};

// closing a task while any of its PR rows is still open would
// leave the work unmerged; `force` is the explicit "done without merging".
export function openPrBlocksDone(prStates: readonly string[], force: boolean): boolean {
  return !force && prStates.some((s) => s !== "merged" && s !== "closed");
}

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

// Pure, so it is unit-testable without a database and so the route handler
// has exactly one thing to do with an illegal move: refuse it.
export function checkTransition(from: string, to: string, repairReason?: unknown, executorMode?: string): TransitionCheck {
  const allowed = TRANSITIONS[from];
  if (!allowed) {
    return { ok: false, reason: `task is in '${from}', which is not a pipeline status - nothing to advance` };
  }
  if (!allowed.includes(to)) {
    return { ok: false, reason: `cannot move a task from '${from}' to '${to}' (allowed: ${allowed.join(", ")})` };
  }
  // A handback to `queued` is what resumes an agent, and the run it resumes
  // needs to know what it is fixing - an unexplained requeue would spawn a
  // session with no idea why it was woken. only a fully
  // autonomous (`agent`) task is handed back. A `human+agent` task has a
  // human on it, and a second agent starting behind their back would race
  // them, so the same failure parks it in `rework` instead - still carrying
  // the reason, so that the human's own requeue resumes with the evidence
  // (see keepRepairOnPatch). `rejected` is a human end-state and carries none.
  const hasReason = repairReason !== undefined && repairReason !== null;
  if (to === "queued" && from === "needs_input") {
    if (hasReason) return { ok: false, reason: "an answered question is not a repair - send no repairReason" };
  } else if (to === "queued") {
    if (!isRepairReason(repairReason)) {
      return { ok: false, reason: `a handback to 'queued' needs repairReason to be one of ${REPAIR_REASONS.join(", ")}` };
    }
    if (executorMode !== undefined && executorMode !== "agent") {
      return { ok: false, reason: `only an executorMode 'agent' task is handed back to an agent; this one is '${executorMode}', park it in 'rework'` };
    }
  }
  if (to === "rework" && hasReason && !isRepairReason(repairReason)) {
    return { ok: false, reason: `repairReason must be one of ${REPAIR_REASONS.join(", ")}` };
  }
  if (to !== "queued" && to !== "rework" && hasReason) {
    return { ok: false, reason: "repairReason only applies to a handback to 'queued' or a park in 'rework'" };
  }
  return { ok: true };
}

// which repair fields a plain PATCH that changes status leaves in
// place. Two rules, both about not letting evidence outlive its failure:
//
// - A requeue out of `rework` keeps them. The only thing that parks a task in
//   `rework` with a repairReason is the pipeline (a human+agent task's failed
//   stage), and the branch still has that failure on it, so the run the human
//   starts should read it exactly as an autonomous handback would.
// - Any other move to `queued` or `rework` clears them unless the caller
//   names them. That covers #157's case (a human requeue from `review` is not
//   a repair) and the runner parking a task in `rework` after its attempts ran
//   out, which must not leave a stale reason for the next requeue to inherit.
//
// Moves to anything else keep them: the runner claims a handed-back task with
// a PATCH to `executing` and reads the repair fields after that.
export function keepRepairOnPatch(fromStatus: string | undefined, toStatus: string): boolean {
  if (toStatus !== "queued" && toStatus !== "rework") return true;
  return fromStatus === "rework" && toStatus === "queued";
}

export interface PipelineTask {
  taskId: number;
  title: string;
  stage: PipelineStatus;
  stageEnteredAt: string | null;
  attemptCount: number;
  projectId: number;
  projectSlug: string;
  // Full "org/name" path - the poller derives the bare repo/gh --repo name
  // from its basename, the same way foreman's runner already does.
  localPath: string | null;
  autoDeployAllowed: boolean;
  // the poller hands a failed stage back to an agent only for
  // `agent`; anything else is parked for the human already on it.
  executorMode: string;
  prUrl: string | null;
  prBranch: string | null;
  prRepoSlug: string | null;
}

// Everything a stateless poller needs to decide what to do next, in one
// round trip: which stage each task is in, how long it has been there, and
// the PR/repo it is about. Ordered oldest-stage-first so a backlog drains in
// the order it built up rather than by task id.
//
// The PR is the task's most recent one (by id), not its most recent *open*
// one: the pipeline follows a PR through being merged, and filtering on
// state would lose the url the moment the merge succeeds.
export async function getPipelineNext(): Promise<PipelineTask[]> {
  const rows = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      stage: tasks.status,
      stageEnteredAt: tasks.pipelineStageEnteredAt,
      executorMode: tasks.executorMode,
      attemptCount: tasks.attemptCount,
      projectId: projects.id,
      projectSlug: projects.slug,
      localPath: projects.localPath,
      autoDeployAllowed: projects.autoDeployAllowed,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(inArray(tasks.status, [...PIPELINE_STATUSES]))
    .orderBy(tasks.pipelineStageEnteredAt, tasks.id);

  if (!rows.length) return [];

  const prRows = await db
    .select()
    .from(pullRequests)
    .where(inArray(pullRequests.taskId, rows.map((r) => r.taskId)))
    .orderBy(desc(pullRequests.id));
  const prByTask = new Map<number, (typeof prRows)[number]>();
  for (const pr of prRows) if (!prByTask.has(pr.taskId)) prByTask.set(pr.taskId, pr);

  return rows.map((r) => {
    const pr = prByTask.get(r.taskId);
    return {
      ...r,
      stage: r.stage as PipelineStatus,
      stageEnteredAt: r.stageEnteredAt ? r.stageEnteredAt.toISOString() : null,
      prUrl: pr?.url ?? null,
      prBranch: pr?.branchName ?? null,
      prRepoSlug: pr?.repoSlug ?? null,
    };
  });
}

// The write half: one legal move, applied atomically-enough for a single
// poller (the transition is checked against the row that was read in the
// same request; two pollers racing the same task would both pass, which is
// acceptable because advancing the same stage twice is idempotent in every
// step the poller performs).
//
// attemptCount is deliberately left alone. PATCH /tasks/:id zeroes it on a
// status change to `queued` (see routes.ts) so a human requeue gets a fresh
// cap; a repair handback must NOT, or a task whose CI keeps failing would be
// handed back forever. Preserving the count means the runner's own attempt
// cap ends the loop exactly as it does for any other retry.
export async function applyTransition(
  taskId: number,
  to: string,
  repairReason?: RepairReason,
  repairContext?: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({
      status: to,
      pipelineStageEnteredAt: isPipelineStatus(to) ? new Date() : null,
      repairReason: to === "queued" || to === "rework" ? (repairReason ?? null) : null,
      repairContext: to === "queued" || to === "rework" ? (repairContext ?? null) : null,
      // a rejected (or, an earlier story, done) task's root grant ends here, so reopening it
      // later needs the operator again (same as routes.ts's close paths).
      ...(to === "rejected" || to === "done" ? { rootGrantExpiresAt: sql`least(${tasks.rootGrantExpiresAt}, now())` } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId));
}
