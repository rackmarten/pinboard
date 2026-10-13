// readiness lint for moving an executorMode=agent task into
// `queued`. An unready task burns agent attempts on questions nobody settled
// during planning, so the move is refused (422) with every failure listed,
// unless the caller sends `force: true`. Pure, so every rule is unit-tested.

export type ReadinessTask = {
  executorMode?: string | null;
  taskType?: string | null;
  estimatedEffort?: number | null;
  priority?: number | null;
  autonomyLevel?: number | null;
  description?: string | null;
  projectId?: number | null;
  relatedProjectIds?: number[] | null;
};

// id + the repo directory name (last segment of localPath), and the org
// directory in front of it, if any.
export type WorkspaceRepo = { id: number; repo: string; org?: string };

const ACCEPTANCE = /^(#+\s*)?(acceptance|done when)/im;
const UNRESOLVED = /^\s*(TBD|\?|Open question|Decide)/im;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A repo counts as mentioned when it appears as a path segment
// (`foreman/app/...`, `my-org/foreman`) or as a `foreman#12` reference.
// a dot-named repo (`.github`) is also an ordinary directory in
// every repo, so a bare `.github/workflows` path is not a mention of it; only
// `<org>/.github` or `.github#12` counts.
export function mentionsRepo(text: string, repo: string, org?: string): boolean {
  const r = escape(repo);
  if (!repo.startsWith(".")) return new RegExp(`(^|[\\s/\`'"(])${r}(/|#\\d)`, "m").test(text);
  if (new RegExp(`(^|[\\s\`'"(])${r}#\\d`, "m").test(text)) return true;
  return !!org && new RegExp(`(^|[\\s/\`'"(])${escape(org)}/${r}(?![\\w-]|\\.\\w)`, "m").test(text);
}

// A move into `queued` is linted only when a person is queueing planned work.
// From `executing` it is foreman handing a claimed task back (a session-limit
// refund, a refused claim), and from `needs_input` it is an answered question
// on a task that already ran: refusing those strands the task mid-flight
// rather than stopping an unready one from starting.
const UNLINTED_FROM = new Set(["executing", "needs_input"]);

export function readinessApplies(fromStatus: string | null | undefined): boolean {
  return !UNLINTED_FROM.has(fromStatus ?? "");
}

export function repoName(localPath: string): string {
  return localPath.replace(/\/+$/, "").split("/").pop() ?? localPath;
}

// a project whose repoUrl is a GitHub org page (`my-org`,
// `rackmarten`, ...) is an org directory, not a repo, so it is never a repo
// the lint asks to relate (foreman could not clone it either).
export function toWorkspaceRepos(
  rows: { id: number; localPath: string | null; repoUrl?: string | null }[],
): WorkspaceRepo[] {
  return rows
    .filter((r) => r.localPath && !/github\.com\/orgs\//.test(r.repoUrl ?? ""))
    .map((r) => {
      const segments = (r.localPath as string).replace(/\/+$/, "").split("/");
      const org = segments.length > 1 ? segments[segments.length - 2] : undefined;
      return { id: r.id, repo: repoName(r.localPath as string), ...(org ? { org } : {}) };
    });
}

export function readinessFailures(task: ReadinessTask, repos: WorkspaceRepo[] = []): string[] {
  const failures: string[] = [];
  const effort = task.estimatedEffort;
  if (effort == null) failures.push("estimatedEffort is not set");
  else if (effort > 8) failures.push(`estimatedEffort ${effort} is over 8 - split it into a story with children`);
  if (!task.priority || task.priority <= 0) failures.push("priority must be > 0");
  if (task.autonomyLevel == null) failures.push("autonomyLevel is not set");
  const description = task.description ?? "";
  if (description.length < 200) failures.push(`description is ${description.length} chars, needs at least 200`);
  if (!ACCEPTANCE.test(description)) failures.push("description has no acceptance section (a line starting with 'Acceptance' or 'Done when')");
  const related = new Set(task.relatedProjectIds ?? []);
  const missing = repos
    .filter((r) => r.id !== task.projectId && !related.has(r.id) && mentionsRepo(description, r.repo, r.org))
    .map((r) => r.repo);
  if (missing.length) failures.push(`description mentions repos not in relatedProjectIds: ${missing.join(", ")}`);
  const open = description.split("\n").filter((l) => UNRESOLVED.test(l)).map((l) => l.trim());
  if (open.length) failures.push(`unresolved questions: ${open.join(" | ")}`);
  return failures;
}
