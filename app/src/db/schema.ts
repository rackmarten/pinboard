import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";

// server-kit keyword search, written by src/keywords.ts.
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

// Task type (idea/research/decision/architecture/implementation/bug/testing/
// review/deployment/maintenance) and status (idea -> defined -> planned ->
// decomposed -> queued -> executing -> handoff -> awaiting_ci ->
// awaiting_merge -> deploying -> verifying -> review -> rework/done, plus
// "rejected" - a terminal status set by hand for an accidental duplicate or
// otherwise unwanted task, so it can be hidden from default views without
// deleting the row or renumbering later IDs) are plain text rather than a
// Postgres enum - see idea-task-management.md's "Task Types"/"Task Lifecycle"
// sections for the values in use today. Kept as text so a new value doesn't
// need a migration, since this list is still expected to grow as real tasks
// get filed - a past task's five pipeline statuses needed no migration of
// their own for exactly that reason.
//
// A past task: the five statuses between "handoff" and
// "review" (awaiting_ci, awaiting_merge, awaiting_review, deploying,
// verifying) are the post-PR pipeline, driven by a cheap foreman poller
// rather than by the agent session that opened the PR. They live here, in
// tasks.status, rather than in a separate pipelineState column precisely so
// governor.ts's concurrency check (`where t.status = 'executing'`) frees the
// agent slot the moment a task enters the pipeline, with nothing new to
// teach it. See pipeline.ts for the legal transitions between them.

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  // Path to the project's local checkout on foreman's LXC (and any other
  // machine sharing the same workspace layout), relative to `work`'s
  // WORKSPACE_ROOT (default ~/projects) - lets `work plan sync` find it to
  // write its generated PLAN.md into. Always org/name (e.g. "my-org/
  // pinboard", "uncik-projects/foo"), since every repo this workspace
  // clones lives two levels down from WORKSPACE_ROOT. Null for a project
  // with no local checkout of its own (e.g. a cross-cutting one). Named
  // localPath rather than repoSlug/repoPath - "repo" reads as "git remote",
  // and this is specifically about where the thing lives on disk.
  localPath: text("local_path"),
  // Full clone/browse URL for the project's repo (e.g.
  // https://github.com/my-org/pinboard) - localPath is the on-disk
  // location `work plan sync` matches against, this is the actual link a
  // human clicks from the UI. Independent of localPath since a project can
  // have one without the other (e.g. a repo outside this workspace layout
  // entirely).
  repoUrl: text("repo_url"),
  // lets a project be filed under another (e.g. a sub-service
  // under its parent's umbrella project) for the projects screen's
  // hierarchy display. Nullable - most projects have no parent. Plain
  // integer rather than a DB-level FK - the API rejects a project being
  // set as its own ancestor (see routes.ts) rather than relying on a DB
  // constraint.
  parentProjectId: integer("parent_project_id"),
  // I13: explicit per-project opt-in for foreman to merge an agent's PR and
  // deploy it automatically once CI is green, instead of leaving it for a
  // human to merge/deploy by hand. Defaults off - a project only gets
  // autonomous deploy rights when someone deliberately turns it on.
  // "production" is never eligible regardless of this flag - see runner.ts.
  autoDeployAllowed: boolean("auto_deploy_allowed").notNull().default(false),
  // I10: soft-archive instead of delete - an archived project keeps its
  // tasks/history but drops out of the default project list/picker.
  archived: boolean("archived").notNull().default(false),
  // I18: current project state only (decisions in force, what's in flight,
  // what a new task needs to know) - kept short and edited in place, not
  // appended to. History belongs in the project repo's own CHANGELOG.md and
  // in closed tasks here, not duplicated into this field - see
  // homelab/AGENTS.md's "Where project knowledge goes".
  context: text("context"),
  // standing relationship - other pinboard projects whose
  // repos an agent run for this project needs write access to, beyond its
  // own localPath (e.g. pinboard's own relatedProjectIds pointing at
  // foreman and homelab-kit's project rows). References projects.id, not a
  // repo slug/path directly - a project is what's actually being related,
  // and its localPath is resolved from the id only when a filesystem path
  // is actually needed. Human-declared, not auto-discovered - see
  // tasks.relatedProjectIds for the per-task addition; foreman's runner
  // combines project + task lists into the effective repo set for a run.
  relatedProjectIds: integer("related_project_ids").array().notNull().default([]),
  keywords: tsvector("keywords"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("projects_keywords_idx").using("gin", table.keywords)]);

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projects.id),
  title: text("title").notNull(),
  description: text("description"),
  taskType: text("task_type").notNull().default("implementation"),
  status: text("status").notNull().default("idea"),
  // human | agent | human+agent - see idea-task-management.md's "Task Types".
  executorMode: text("executor_mode").notNull().default("human"),
  priority: integer("priority").notNull().default(0),
  // 0-5, see idea-task-management.md's "Autonomy Levels". Nullable: not
  // every task has an autonomy decision made yet.
  autonomyLevel: integer("autonomy_level"),
  // Story-point-like AI effort scale (1/2/3/5/8/13), not engineering time.
  // Constrained at the API layer, not the DB, so the set can grow without a
  // migration - see PLAN.md's I0 carry-forward note on constraining this.
  estimatedEffort: integer("estimated_effort"),
  actualCostUsd: text("actual_cost_usd"),
  actualDurationMs: integer("actual_duration_ms"),
  // Set by foreman's agent runner (I4a) while a `claude -p` session is
  // executing this task, renewed periodically until it exits. Past this
  // timestamp the claim is considered abandoned (a crashed runner) and the
  // task becomes reclaimable even though status is still "executing".
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  // Incremented by the runner before each spawn, independent of whether a
  // handoff row ever gets written - a crashed/killed attempt still counts
  // against the attempt cap.
  attemptCount: integer("attempt_count").notNull().default(0),
  // I4c: set by the pinboard UI's running-workers screen while a task is
  // leased to a live run, polled by foreman's runner (which only reaches
  // out to pinboard, never the other way around) and cleared once acted
  // on. null | "stop" (SIGINT, give the session a chance to exit cleanly)
  // | "kill" (SIGKILL immediately) - see runner.ts's runOneAttempt.
  controlAction: text("control_action"),
  controlRequestedAt: timestamp("control_requested_at", { withTimezone: true }),
  // one-off addition of other pinboard projects this specific
  // task needs write access to, on top of whatever its project already
  // grants via projects.relatedProjectIds (e.g. a pinboard task needing
  // homelab-kit even though most pinboard tasks don't). References
  // projects.id - see projects.relatedProjectIds above for why. Effective
  // repo list for a run = [project.localPath] + project.relatedProjectIds
  // + task.relatedProjectIds, each resolved to its project's localPath and
  // deduped.
  relatedProjectIds: integer("related_project_ids").array().notNull().default([]),
  // last known `claude -p` session id for this task's coding
  // attempts, and the name of the worktree it's still sitting in (branch is
  // always derived as `worktree-${activeWorktreeName}`) - set by foreman's
  // runner after an attempt so a later attempt (an automatic in-loop retry,
  // or a fresh run after a human requeues from review/rework) can `--resume`
  // it instead of starting cold. Same precedent as chatThreads.claudeSessionId
  // below, extended to task-attempt worktree sessions. Both null once the
  // task reaches done/rejected or the worktree is swept for exceeding its
  // retention window - see runner.ts's prepareAttempt/sweepRetainedWorktrees.
  claudeSessionId: text("claude_session_id"),
  // which license's `~/.claude` the id above lives in. A Claude
  // session only exists in the store of the Linux user that created it, so
  // resuming one under a different seat fails instantly with "No conversation
  // found with session ID". That is how #166 and #169 each burned their whole
  // attempt cap in 25 seconds on 2026-09-17: marek's 5h window closed
  // mid-run, the session was retained, and the per-seat dispatcher (#152)
  // offered the requeued task to peter's seat, which had never heard of it.
  // Null means "owner unknown" - foreman's prepareAttempt treats that as not
  // resumable and starts cold rather than gambling an attempt on it.
  claudeSessionLicenseId: integer("claude_session_license_id").references(() => licenses.id),
  activeWorktreeName: text("active_worktree_name"),
  // when this task entered its current post-PR pipeline status,
  // so the poller can age a stage out (CI that never finishes, a deploy that
  // hung) without keeping per-task state of its own - it is stateless by
  // design and re-derives everything from what it reads here. Null whenever
  // the task is not in a pipeline status.
  pipelineStageEnteredAt: timestamp("pipeline_stage_entered_at", { withTimezone: true }),
  // why a pipeline stage handed the task back to `queued` for
  // another agent run - ci_failed | merge_conflict | deploy_failed - and the
  // evidence that run needs to act on it (the failing CI step's log, git's
  // conflict output, the deploy script's stderr). A failed stage deliberately
  // is NOT its own status: putting the task back to `queued` means the
  // existing dispatch/gating/attempt-cap path picks it up unchanged, and the
  // attempt cap is what stops a repair loop from running forever. Both are
  // set only by a handback transition and cleared by every other one - see
  // pipeline.ts.
  repairReason: text("repair_reason"),
  repairContext: text("repair_context"),
  // A past task: root access. `rootScope` is the containers (CTIDs) a
  // `root-access`-labelled task wants root on, editable like any other field.
  // The grant columns are the operator's approval: written only by
  // POST /tasks/:id/root-grant (operator devices only, see root-grants.ts),
  // never by PATCH. The CTIDs are copied at grant time, so editing rootScope
  // afterwards does not widen a grant that already exists. Homelab's
  // rootproxy on the Proxmox host asks GET /tasks/:id/root-grant before every
  // call.
  rootScope: integer("root_scope").array().notNull().default([]),
  rootGrantCtids: integer("root_grant_ctids").array(),
  rootGrantExpiresAt: timestamp("root_grant_expires_at", { withTimezone: true }),
  rootGrantedAt: timestamp("root_granted_at", { withTimezone: true }),
  rootGrantedBy: text("root_granted_by"),
  keywords: tsvector("keywords"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("tasks_keywords_idx").using("gin", table.keywords)]);

export const labels = pgTable("labels", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color"),
});

export const taskLabels = pgTable(
  "task_labels",
  {
    taskId: integer("task_id").notNull().references(() => tasks.id),
    labelId: integer("label_id").notNull().references(() => labels.id),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.labelId] })],
);

// I10: relationType constrained at the API layer (routes.ts's
// RELATION_TYPES) to parent | child | related | depends_on, directional
// fromTaskId -> toTaskId - e.g. (A, "depends_on", B) means A depends on B
// (was "blocked_by" until foreman's scheduler actually started enforcing
// it - see runner.ts's findNextRunnableTask). Existed unused since I1a with a
// looser planned vocabulary (blocks/relates_to/duplicates); the set above
// is what I10 actually built routes and UI for.
export const taskRelations = pgTable("task_relations", {
  id: serial("id").primaryKey(),
  fromTaskId: integer("from_task_id").notNull().references(() => tasks.id),
  toTaskId: integer("to_task_id").notNull().references(() => tasks.id),
  relationType: text("relation_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// authorType distinguishes a human's own words from an agent's, per
// idea-task-management.md's "Agent Users / Provenance" - this is the
// persistent handoff mechanism, not just a comment thread.
export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id),
  authorType: text("author_type").notNull(),
  authorName: text("author_name").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// an account/license under a provider - e.g. a second person
// working on the same homelab via foreman, with their own budget, usage
// tracking and governor scoping instead of sharing the single global scope
// every agent used to draw from. Deliberately called "license", not
// "instance" or "account" - this is prep for multiple *providers* in the
// future, built now only as far as 2 licenses under 1 provider, so the name
// should read as "a seat under a provider" rather than implying a whole
// separate deployment. linuxUser is the OS user foreman spawns a `claude`
// process under for this license's agents (see foreman's runner.ts) -
// creating that user and its own ~/.claude is a manual, one-time operator
// step, not something this table or any migration does.
// sessionBudgetUsd/concurrencyLimit are nullable overrides of the same
// appSettings-level defaults (null = fall back to appSettings, then
// config.governor) - the $ envelope for a whole period still lives on
// budgetPeriods, which gets its own licenseId below.
export const licenses = pgTable("licenses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  provider: text("provider").notNull(),
  linuxUser: text("linux_user").notNull(),
  // Name of the env var on foreman holding this seat's `claude setup-token`
  // OAuth token (a secret in the runner's environment, e.g.
  // CLAUDE_OAUTH_TOKEN_PETER). Only the name lives here, never the value;
  // foreman passes the value to its claude spawn as CLAUDE_CODE_OAUTH_TOKEN.
  // null = spawn with foreman's own ~/.claude login.
  tokenEnvVar: text("token_env_var"),
  sessionBudgetUsd: text("session_budget_usd"),
  concurrencyLimit: integer("concurrency_limit"),
  // The operator's "the window isn't really spent" override (Plan screen's
  // Reset button). The planner ignores spend and session-limit reports from
  // before this instant, so the next run opens a fresh derived window. If the
  // real window was spent after all, that run's session-limit error is
  // reported after this and wins again.
  sessionResetAt: timestamp("session_reset_at", { withTimezone: true }),
  // weekly recurring budget periods. When enabled and no period
  // covers now, the planner inserts the next one lazily (recurrence.ts),
  // anchored on this license's latest period's endsAt, +7 days at a time.
  // The amount is the pattern's own, separate from the current period's
  // budgetUsd. Money as text, same precedent as budgetPeriods.budgetUsd.
  recurrenceEnabled: boolean("recurrence_enabled").notNull().default(false),
  recurrenceBudgetUsd: text("recurrence_budget_usd"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Agent *definitions* only - credentials never live here, see
// idea-task-management.md's "Agent configuration is split deliberately".
// credentialRef is a name foreman resolves against its own secret store.
export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  role: text("role"),
  provider: text("provider").notNull(),
  model: text("model"),
  executor: text("executor").notNull(),
  autonomyLevel: integer("autonomy_level").notNull().default(0),
  credentialRef: text("credential_ref"),
  routingWeight: integer("routing_weight").notNull().default(1),
  enabled: boolean("enabled").notNull().default(true),
  // which license this agent runs under - determines the Linux
  // user foreman dispatches it as (via license.linuxUser) and the
  // budget/usage/concurrency scope its runs count against. Required: every
  // agent belongs to exactly one license, backfilled to a single "default"
  // license by the 0024 migration so existing single-scope behavior is
  // unchanged until a second license actually exists.
  licenseId: integer("license_id").notNull().references(() => licenses.id),
  // grants foreman's chat.ts unrestricted "host" persona to this
  // agent's threads (full tool access, no --allowedTools/--disallowedTools)
  // instead of every other agent's restricted read-only planning persona.
  // Replaces the old scheme of matching a single hardcoded agent name
  // ("foreman-host"), which agents.name's unique constraint meant only one
  // license could ever satisfy - isHost is per-agent, so each license can
  // flag its own.
  isHost: boolean("is_host").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// I12a: deterministic routing rules - which agent should run a task when
// none is explicitly requested, matched by task type and/or label (both
// nullable = wildcard, matches any). Consumed by foreman's dispatcher
// (routing.ts) when resolving which agent to actually spawn for a given
// task - not enforced here at claim time like the I6 concurrency limits,
// since routing is a dispatch-time choice, not a security boundary.
export const routingRules = pgTable("routing_rules", {
  id: serial("id").primaryKey(),
  taskType: text("task_type"),
  labelName: text("label_name"),
  agentId: integer("agent_id").notNull().references(() => agents.id),
  // Among multiple matching rules, higher priority wins; ties broken by the
  // matched agent's own routingWeight, then rule id - see routing.ts.
  priority: integer("priority").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per completed agent session, per idea-task-management.md's
// "Handoff Mechanism" and the I0 carry-forward note: usage fields have a
// home from the start even though nothing reads them until I5.
export const handoffs = pgTable("handoffs", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id),
  agentId: integer("agent_id").references(() => agents.id),
  completed: text("completed"),
  changed: text("changed"),
  verified: text("verified"),
  problems: text("problems"),
  discovered: text("discovered"),
  next: text("next"),
  estimatedNextEffort: integer("estimated_next_effort"),
  costUsd: text("cost_usd"),
  durationMs: integer("duration_ms"),
  numTurns: integer("num_turns"),
  permissionDenials: jsonb("permission_denials"),
  // optional markdown TL;DR the session writes for the operator.
  summary: text("summary"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Manually-entered allowance checkpoints (PLAN.md's I6 governor). Claude's
// own UI only ever shows a whole-number percent remaining - no $ figure, no
// decimals - for two independent windows (the weekly allowance and the
// rolling 5h session). There is no API to read either one, so the operator
// periodically punches in what they currently see; the governor treats the
// latest one per scope as current until the next entry, rather than trying
// to interpolate between them (that would need a reliable $-per-% ratio,
// and a promo or plan change can move that number at any time - see
// governor.ts's note on why that ratio is informational only, not load-
// bearing for the gating decision).
export const usageObservations = pgTable("usage_observations", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull(), // "week" | "session"
  percentRemaining: integer("percent_remaining").notNull(),
  note: text("note"),
  // "manual" (operator punched in what Claude's own UI shows) or
  // "derived" (governor.ts computed it from real handoff cost + the current
  // budget rate). A manual reading stays authoritative until its scope's
  // current cycle ends - see governor.ts's effectiveObservation - so both
  // kinds live in the same table rather than a separate derived-only one,
  // keeping "what's the latest reading" a single ordered sequence per scope.
  source: text("source").notNull().default("manual"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// I16: operator-entered $-to-% conversion rates, effective-dated rather than
// a single mutable settings row so a past rate stays recoverable if the plan
// or promo changes it later. Both rates live on the same row (one operator
// reading of "what Claude currently charges me per 1%" naturally covers both
// windows at once) - see budget-rates.ts for how a rate is picked for a given
// timestamp and used to turn a real costUsd into an estimated %-of-window.
export const budgetRates = pgTable("budget_rates", {
  id: serial("id").primaryKey(),
  usdPerSessionPercent: text("usd_per_session_percent").notNull(),
  usdPerWeekPercent: text("usd_per_week_percent").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// append-only log written every time `recordBudgetRate` adds a
// new effective-dated row above, kept as its own table (rather than reusing
// `budgetRates` directly) so a "how has the $-to-% rate drifted over time"
// chart has a plain date+rate sequence to read, without needing to reason
// about effective-dating or a specific point-in-time lookup the way
// governor.ts's `getRateAt` does for the operational rate.
export const budgetRateHistory = pgTable("budget_rate_history", {
  id: serial("id").primaryKey(),
  usdPerSessionPercent: text("usd_per_session_percent").notNull(),
  usdPerWeekPercent: text("usd_per_week_percent").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

// append-only log of every real $ cost as it lands, from any
// source. Exists because the 5h session window (see session-windows.ts) has
// to be derived from *when* money was spent, and the two places spend is
// recorded today can't both answer that: `handoffs` has one row per session
// with a timestamp (fine), but `chatThreads` only carries a running
// `totalCostUsd` that is incremented in place (no per-turn history at all).
// Deriving windows from handoffs alone would silently ignore chat spend,
// which is exactly the kind of wrong number the planner must not be built
// on.
//
// Written by the same routes that already record cost (the handoff route and
// the chat usage route) rather than replacing either - `handoffs` stays the
// structured session record, `chatThreads.totalCostUsd` stays the per-thread
// running total, and this table is the flat time series both of them feed.
// The 0023 migration backfills every existing handoff; historical chat spend
// cannot be backfilled per-turn (the deltas were never stored), so windows
// before that migration under-count chat and are marked as such in the UI.
export const usageEvents = pgTable("usage_events", {
  id: serial("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  // Same text-for-money precedent as handoffs.costUsd - see the note there.
  costUsd: text("cost_usd").notNull(),
  source: text("source").notNull(), // "handoff" | "chat"
  taskId: integer("task_id").references(() => tasks.id),
  chatThreadId: integer("chat_thread_id").references(() => chatThreads.id),
  handoffId: integer("handoff_id").references(() => handoffs.id),
  // which license this cost counts against, resolved from the
  // spending agent at write time and denormalized here rather than derived
  // via a join at read time - usage_events is append-only, and a join
  // through agents.licenseId would silently rewrite historical attribution
  // if an agent's license was ever reassigned later. See routes.ts's handoff
  // and chat-usage routes for how this is resolved on write.
  licenseId: integer("license_id").notNull().references(() => licenses.id),
});

// what Claude itself said about a 5h session boundary, recorded
// whenever a run dies with "You've hit your session limit - resets <time>
// (UTC)". Append-only for the same reason usage_events is: it is evidence of
// what happened, not mutable state, and keeping the history means a wrong
// parse is visible afterwards rather than having silently overwritten the
// truth.
//
// This exists because session windows are otherwise only *inferred* (first
// billable action + 5h, see session-windows.ts). The inference is wrong in
// the one case that costs money: when the derived window has expired but the
// real one has not, the planner happily starts task after task into a wall.
// A report is the only ground truth available - there is no API for it.
export const sessionLimitReports = pgTable("session_limit_reports", {
  id: serial("id").primaryKey(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  // Parsed from the error text. The error gives a wall-clock time in UTC with
  // no date ("resets 1:40am (UTC)"), so the writer resolves it to the next
  // occurrence of that time - see foreman's session-limit.ts.
  resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
  licenseId: integer("license_id").notNull().references(() => licenses.id),
  // Which run hit the wall. Nullable because a chat turn can hit it too.
  taskId: integer("task_id").references(() => tasks.id),
  // The raw error line, kept verbatim so a parse that drifts when Claude
  // rewords the message can be diagnosed from the record itself.
  rawError: text("raw_error"),
});

// the operator's own $ budget for a period (normally one weekly
// allowance cycle, ending at the configured weekly reset - see settings.ts's
// getWeeklyResetSetting). Replaces the %-of-allowance model as the thing the
// planner and the claim-time gate actually read: the operator can read a $
// figure off Claude's own UI directly, and the %-to-$ conversion the governor
// used to do was meaningless for the rolling 5h window anyway (see plan.ts).
//
// One row per period rather than a mutable settings value, so past periods
// stay readable for "how much did I actually budget vs spend that week" -
// same reasoning as budgetRateHistory above. The current period is the one
// whose [startsAt, endsAt) contains now; periods are not required to be
// contiguous, and a gap just means no autonomous budget was set for that
// stretch.
export const budgetPeriods = pgTable("budget_periods", {
  id: serial("id").primaryKey(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  // Same text-for-money precedent as handoffs.costUsd - see the note there.
  budgetUsd: text("budget_usd").notNull(),
  note: text("note"),
  // a period now belongs to exactly one license - budgets are
  // fully separate per license, not a shared pool. Backfilled to the same
  // default license as agents/usage_events by the 0024 migration.
  licenseId: integer("license_id").notNull().references(() => licenses.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only audit trail (status changes, claims, comments, etc.) -
// separate from `comments`, which is the human-readable discussion thread.
//
// this is also the homelab-wide journal now, not only a task's own
// history. taskId is nullable so a project edit, a chat thread or a settings
// change can be journaled too, and projectId is stored (resolved from the
// task when there is one) so a project timeline is one indexed query rather
// than a join through tasks. The table keeps its old name - every existing
// row is still a task event, and renaming it would touch every reader for
// nothing. `payload` is pruned to null after a few months (journal.ts), the
// row itself stays.
export const taskEvents = pgTable(
  "task_events",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id").references(() => tasks.id),
    projectId: integer("project_id").references(() => projects.id),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorName: text("actor_name").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("task_events_created_at_idx").on(table.createdAt),
    index("task_events_project_id_idx").on(table.projectId, table.createdAt),
  ],
);

// things that need the operator's attention, derived from journal
// events by notifications.ts. Everyone sees every notification for now (there
// is no per-operator identity beyond "on the tailnet"), so readAt is global.
export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id").references(() => taskEvents.id, { onDelete: "set null" }),
    taskId: integer("task_id").references(() => tasks.id),
    projectId: integer("project_id").references(() => projects.id),
    // failure | review | approval | question | completed
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // PWA route to open, e.g. /tasks/12 or /chat/4.
    url: text("url"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("notifications_created_at_idx").on(table.createdAt)],
);

// what is deployed where, one row per declared deploy step of a
// project, reported by foreman's release probe (it SSHes each step's host and
// compares the checkout's HEAD with the default branch on GitHub). Replaced
// wholesale per project on every probe, so a step removed from the
// declaration disappears here too. app is "" for an `lxc` step rather than
// null so the unique index works.
export const deployTargets = pgTable(
  "deploy_targets",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    app: text("app").notNull().default(""),
    deployedSha: text("deployed_sha"),
    mainSha: text("main_sha"),
    // null when unknown (deployed sha unreadable, or not an ancestor of main)
    pendingCount: integer("pending_count"),
    // [{ sha, subject }], newest first, capped by the probe
    pendingCommits: jsonb("pending_commits"),
    probeError: text("probe_error"),
    // a human-gated production release target (the `release` block
    // of the repo's declaration) rather than a step that deploys after a
    // merge. deployedVersion is the image tag it runs, e.g. "v0.2.0";
    // deployedSha is the commit that tag points to.
    release: boolean("release").notNull().default(false),
    deployedVersion: text("deployed_version"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("deploy_targets_step_idx").on(table.projectId, table.host, table.app)],
);

// "Deploy now" from the releases view. Pinboard holds no
// credentials, so a click only queues a row; foreman's pipeline loop claims
// it, runs deploy-service.sh for the project's repo and reports back.
// status: queued -> running -> succeeded | failed.
export const deployRequests = pgTable("deploy_requests", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),
  // "deploy" (Deploy now: the repo's steps) or "release" (a
  // production release, bumping the version by `bump`: patch|minor|major).
  // `version` is the release's resulting tag once foreman has chosen it.
  kind: text("kind").notNull().default("deploy"),
  bump: text("bump"),
  version: text("version"),
  requestedBy: text("requested_by").notNull(),
  output: text("output"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// PLAN.md's I8: pinboard-mediated message passing for a planning chat with
// a real Claude session on foreman (foreman never accepts inbound
// connections, so this can't be a direct socket - foreman polls for
// awaitingAgent threads the same way it already polls for queued tasks).
// projectId is nullable - a cross-cutting planning chat doesn't have to be
// scoped to one repo.
//
// I9: taskId (also nullable) links a thread to the task whose own running
// session is asking a question, instead of (or alongside) a project - see
// routes.ts's /chat/threads taskId filter and /tasks/:id/chat-thread. A
// task-scoped thread is never touched by foreman's own I8 planning-chat
// poller (it explicitly excludes taskId-linked threads); only the task's
// own runner session, via `work task ask`, ever posts as "agent" on it.
export const chatThreads = pgTable("chat_threads", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").references(() => projects.id),
  taskId: integer("task_id").references(() => tasks.id),
  // which agent (from the same agents table routing rules use)
  // foreman should talk to for this thread. Null keeps foreman's existing
  // default (its planning agent) so old threads and un-set new ones behave
  // the same as before this column existed.
  agentId: integer("agent_id").references(() => agents.id),
  // per-thread overrides of the chosen agent's own model, plus a
  // reasoning-effort hint, both passed through to foreman's `claude -p`
  // invocation (chat.ts). Null keeps foreman's existing default (the
  // agent's own configured model, and foreman's default effort) so old
  // threads and un-set new ones behave the same as before these columns
  // existed - same nullable-override precedent as agentId itself.
  model: text("model"), // "sonnet" | "opus" | null
  effort: text("effort"), // "medium" | "high" | null
  title: text("title").notNull(),
  status: text("status").notNull().default("open"), // open | closed
  awaitingAgent: boolean("awaiting_agent").notNull().default(false),
  // a chat thread's own running usage bucket, accumulated by
  // foreman (POST /chat/threads/:id/usage) after each turn - separate from
  // `handoffs`/`tasks.actualCostUsd`, which are keyed to a task and don't
  // apply here since a chat thread has none. Same text-for-money precedent
  // as handoffs.costUsd/tasks.actualCostUsd (see schema.ts's note there).
  totalCostUsd: text("total_cost_usd").notNull().default("0"),
  totalDurationMs: integer("total_duration_ms").notNull().default(0),
  // Set by foreman after a thread's first turn so later turns can `claude -p
  // --resume <id>` instead of re-paying the full session baseline. See
  // chat.ts's fallback for when a stored id is no longer resumable.
  claudeSessionId: text("claude_session_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// I15: structured PR/MR tracking paired to a task, replacing the plain-text
// comment foreman previously used as the only record of "a PR exists for
// this task". state is kept fresh by foreman polling `gh pr view` - see
// pull-requests.ts's poller in that repo, not enforced here.
export const pullRequests = pgTable("pull_requests", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull().references(() => tasks.id),
  url: text("url").notNull(),
  repoSlug: text("repo_slug").notNull(),
  branchName: text("branch_name"),
  state: text("state").notNull().default("open"), // open | merged | closed
  attemptNumber: integer("attempt_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// singleton row (id always 1) holding the operator's own weekly
// usage-reset point, so usage.ts's "since reset" rollups can match a real
// plan allowance reset instead of a fixed Mon-00:00 calendar week. Nullable
// columns fall back to config.governor's env-var defaults (already Friday
// 16:00) when this row doesn't exist yet or a column was never set - see
// settings.ts's getWeeklyResetSetting. Deliberately separate from
// config.governor.resetDayOfWeek/resetHour (which stays as the deploy-time
// default and still drives the governor's own gating) rather than replacing
// it, since changing this setting from the Usage screen shouldn't require a
// redeploy.
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey(),
  weeklyResetDayOfWeek: integer("weekly_reset_day_of_week"), // 0=Sunday..6=Saturday
  weeklyResetHour: integer("weekly_reset_hour"), // 0-23, server-local time
  // standing planner config, all nullable and all falling back to
  // config.governor's deploy-time defaults the same way the two weekly-reset
  // columns above already do - so changing any of them is a UI edit, not a
  // redeploy.
  //
  // sessionBudgetUsd: the $ ceiling for one 5h session window (Claude's
  // rolling short-window limit, expressed in $ rather than %).
  // defaultTaskCostUsd: cold-start estimate for a task with no usable
  // history - see cost-model.ts on why this is a per-task mean and not a
  // $/effort-point rate.
  // concurrencyGlobal: how many agent tasks may execute at once, overriding
  // config.governor.concurrency.global.
  // useEffortScaling: whether a task's effort scales its cost estimate (see
  // cost-model.ts). Null means never set, which counts as on.
  sessionBudgetUsd: text("session_budget_usd"),
  defaultTaskCostUsd: text("default_task_cost_usd"),
  concurrencyGlobal: integer("concurrency_global"),
  useEffortScaling: boolean("use_effort_scaling"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").notNull().references(() => chatThreads.id),
  role: text("role").notNull(), // human | agent
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A past task: the live-session chat transcript. A
// chat turn under the Agent SDK daemon is no longer one opaque
// `claude -p` result blob - it is a stream of tool calls, text deltas,
// thinking and cost ticks that the operator should see as they happen, the
// same way Claude Code's own transcript does.
//
// Deliberately a separate table rather than a `kind` column on
// `chatMessages` (operator's call 2026-09-17): `chatMessages` stays the
// clean human/agent conversation every existing query and view already
// reads, and nothing that reads it has to learn to filter transcript noise
// out. The two are joined only by threadId and time.
//
// Append-only: an event is a record of something that happened, never
// edited afterwards. `turn` groups the events of one agent turn (foreman's
// own counter, starting at 1); `seq` orders them inside that turn as
// foreman emitted them, which matters because a batch POST can carry
// several events whose `createdAt` lands in the same millisecond. Ordering
// for replay is by `id` (monotonic per insert) with `(turn, seq)` as the
// stable tiebreak foreman itself assigned.
//
// Retention is a per-thread cap trimmed on write - see chat-events.ts's
// EVENTS_PER_THREAD_CAP. A cap rather than an age sweep because the failure
// mode being guarded against is one runaway turn emitting tens of thousands
// of deltas, which an age-based nightly job would not catch until the next
// night.
export const chatEvents = pgTable(
  "chat_events",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id").notNull().references(() => chatThreads.id),
    turn: integer("turn").notNull().default(0),
    seq: integer("seq").notNull().default(0),
    // See chat-events.ts's EVENT_KINDS for the values in use. Text rather
    // than a Postgres enum for the same reason tasks.status is - the set is
    // still expected to grow as the SDK daemon learns to emit more of what
    // it sees.
    kind: text("kind").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The only access pattern this table has, and it has it three times per
  // batch: replay (`where thread_id = ? and id > ? order by id`), the
  // retention trim's offset subquery, and the PWA's initial load. This is
  // the one table here expected to reach six figures of rows, so unlike the
  // rest of the schema it does not get to rely on a sequential scan being
  // cheap enough.
  (table) => ({ threadIdIdIdx: index("chat_events_thread_id_id_idx").on(table.threadId, table.id) }),
);

// what "don't ask again" actually grants, persisted so it
// outlives both the turn and a foreman restart.
//
// Today that decision is a Set of `Bash:git commit -m`-style signatures
// living inside an MCP subprocess that dies at the end of every turn (see
// foreman's permission-server.ts) - which is why "approve always" was
// pressed six times in thread #26 and never once prevented a later prompt.
//
// Columns are the Agent SDK's own `PermissionRuleValue`/`PermissionUpdate`
// shape (toolName + optional ruleContent + behavior) rather than foreman's
// hand-rolled signature, so a past task's canUseTool can hand a stored rule
// straight back to the SDK as `{ type: "addRules", rules: [...], behavior,
// destination: "session" }` and let Claude Code do the matching. pinboard
// deliberately does NOT implement a matcher of its own: reimplementing the
// SDK's rule semantics here would be a second, silently diverging authority
// on what an approval covers.
//
// scope is pinboard's own lifecycle concept on top of that: "thread" is the
// real "don't ask again", "turn" reproduces today's narrower per-turn
// memory for a grant the operator doesn't want to be permanent. A
// turn-scoped rule records the `turn` it was granted in and stops applying
// once that turn ends.
//
// Revoked rather than deleted (revokedAt) so the record of what was granted
// and when survives - the same reason usage_events is append-only.
export const chatPermissionRules = pgTable("chat_permission_rules", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id").notNull().references(() => chatThreads.id),
  toolName: text("tool_name").notNull(),
  ruleContent: text("rule_content"),
  behavior: text("behavior").notNull(), // allow | deny | ask
  scope: text("scope").notNull().default("thread"), // thread | turn
  turn: integer("turn"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

// structured asks from an agent run. A `question` offers 2-4
// options with exactly one recommended; answering it posts the answer into
// the task's thread and requeues a task parked in needs_input. An
// `assumption` is something the run decided on its own and went ahead with;
// the operator accepts it (answer) or vetoes it, which sends the task to
// rework. Logic lives in asks.ts.
export const taskAsks = pgTable(
  "task_asks",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id").notNull().references(() => tasks.id),
    threadId: integer("thread_id").references(() => chatThreads.id),
    kind: text("kind").notNull(), // question | assumption
    context: text("context"),
    question: text("question").notNull(),
    options: jsonb("options").notNull().default([]), // [{label, rationale, recommended}]
    defaultOption: integer("default_option"),
    status: text("status").notNull().default("open"), // open | answered | vetoed | accepted
    answerOption: integer("answer_option"),
    answerText: text("answer_text"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_asks_status_idx").on(table.status), index("task_asks_task_id_idx").on(table.taskId)],
);
