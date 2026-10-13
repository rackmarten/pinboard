// the releases view's rules - which project a deploy report
// belongs to, and what a probe report must look like. Pure (no db, no
// Fastify) so it can be unit tested without a Postgres, the same split
// notifications.ts uses; the routes live in releases-routes.ts.

// Journal event types the releases view's History tab shows: deploys (from
// deploy-service.sh, whoever ran it), Deploy-now clicks, agent runs finishing
// (handoff) and human reviews (complete/reject).
// A past task adds production release clicks (release_requested).
export const HISTORY_EVENT_TYPES = ["deploy", "deploy_requested", "release_requested", "handoff", "complete", "reject"] as const;

// how a production release bumps the app's version.
export const RELEASE_BUMPS = ["patch", "minor", "major"] as const;
export type ReleaseBump = (typeof RELEASE_BUMPS)[number];

// A release click's body. Patch when nothing is said, the common case.
export function parseReleaseBump(body: unknown): ReleaseBump {
  const bump = (body as { bump?: unknown } | null)?.bump ?? "patch";
  if (!RELEASE_BUMPS.includes(bump as ReleaseBump)) throw new Error(`bump must be one of ${RELEASE_BUMPS.join(", ")}`);
  return bump as ReleaseBump;
}

// Pending commits kept per target. The count stays exact; only the list is cut.
export const MAX_PENDING_COMMITS = 30;

const REQUEST_OUTPUT_MAX_CHARS = 20_000;

interface ProjectRef {
  id: number;
  localPath: string | null;
  archived: boolean;
}

// deploy-service.sh knows a repo by its directory name, pinboard knows a
// project by localPath ("<org>/<repo>"). Prefer a live project over an
// archived one if both carry the same repo.
export function findProjectForRepo<P extends ProjectRef>(projects: readonly P[], repo: string): P | null {
  const matches = projects.filter((p) => p.localPath?.split("/")[1] === repo);
  return matches.find((p) => !p.archived) ?? matches[0] ?? null;
}

export interface PendingCommit {
  sha: string;
  subject: string;
}

export interface TargetReport {
  host: string;
  app: string;
  deployedSha: string | null;
  mainSha: string | null;
  pendingCount: number | null;
  pendingCommits: PendingCommit[];
  probeError: string | null;
  release: boolean;
  deployedVersion: string | null;
}

function optString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

// Validates foreman's probe report for one project. Throws with a message
// fit for a 400.
export function parseTargetReport(body: unknown): TargetReport[] {
  const targets = (body as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets)) throw new Error("targets must be an array");
  const seen = new Set<string>();
  return targets.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    if (typeof t.host !== "string" || t.host === "") throw new Error(`targets[${i}].host is required`);
    const app = typeof t.app === "string" ? t.app : "";
    const key = `${t.host}\t${app}`;
    if (seen.has(key)) throw new Error(`targets[${i}] duplicates ${t.host}${app ? `/${app}` : ""}`);
    seen.add(key);
    const pendingCount = typeof t.pendingCount === "number" && Number.isInteger(t.pendingCount) && t.pendingCount >= 0 ? t.pendingCount : null;
    const commits = Array.isArray(t.pendingCommits) ? t.pendingCommits : [];
    return {
      host: t.host,
      app,
      deployedSha: optString(t.deployedSha),
      mainSha: optString(t.mainSha),
      pendingCount,
      pendingCommits: commits
        .filter((c): c is PendingCommit => typeof c?.sha === "string" && typeof c?.subject === "string")
        .slice(0, MAX_PENDING_COMMITS)
        .map((c) => ({ sha: c.sha, subject: c.subject })),
      probeError: optString(t.probeError),
      release: t.release === true,
      deployedVersion: optString(t.deployedVersion),
    };
  });
}

export function truncateRequestOutput(text: string): string {
  return text.length <= REQUEST_OUTPUT_MAX_CHARS ? text : `…${text.slice(-REQUEST_OUTPUT_MAX_CHARS)}`;
}
