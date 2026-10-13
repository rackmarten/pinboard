# pinboard

[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/rackmarten)

A work database with a human UI, and the front half of a pair:

- **pinboard** (this repo) holds projects, tasks, comments, labels, agent
  definitions, budgets and releases, with a mobile-friendly PWA on top. It
  holds no credentials and has no access to anything else.
- **[foreman](https://github.com/rackmarten/foreman)** is the agent runner. It polls pinboard for queued
  tasks, runs each one as a Claude Code session in its own clone of the
  repo, opens a pull request and reports back. Nothing calls into it.

You plan and review in pinboard; foreman picks up what you queue and does it.

> **Scope.** This is the author's homelab tooling, published in case it is
> useful. It works for one operator and a handful of repos; it is not a
> product, and there is no hosted version.

## Quickstart

You need Docker with the compose plugin, and an Anthropic credential for the
agent side (see below).

    git clone https://github.com/rackmarten/pinboard.git
    cd pinboard
    cp .env.example .env

Edit `.env` and set at least:

    POSTGRES_PASSWORD=<something long and random>
    ANTHROPIC_API_KEY=<your key>
    COMPOSE_PROFILES=runner

Then:

    docker compose up -d

The UI is on **port 8095** (`http://<host>:8095`, change it with `APP_PORT`).
`docker compose ps` should show `pinboard-db`, `pinboard-app`,
`pinboard-backup` and `pinboard-foreman` running, and
`curl http://localhost:8095/health` answers `ok`.

Leave `COMPOSE_PROFILES` unset to run pinboard alone, without the runner.

To build both images from source instead of pulling them (for contributors,
with a foreman checkout next to this one at `../foreman`):

    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

`scripts/smoke-public-stack.sh [--build|--image]` runs that whole path end to
end: it brings the stack up under its own project name, checks both health
paths, queues a task through the API, waits for foreman to pick it up and
tears everything down again.

### Before foreman can do real work

The runner starts with nothing to work on. In the UI:

1. Set a **budget period** on the default license (Plan page): the planner
   starts nothing while no period covers the current time.
2. Create an **agent** (Settings → Agents): a name, model and autonomy level,
   attached to the default license, with executor `cli`. foreman only hands
   queued tasks to `cli` agents; an agent with any other executor is never
   picked, and its tasks stay queued.
3. Create a **project** per repository, with `localPath` set to
   `<org>/<repo>` and `repoUrl` to its GitHub URL.
4. Set `GH_TOKEN` in `.env` (a token with repo and workflow access to those
   repositories) so foreman can clone, push and open pull requests.
5. Create a task, set its executor to `agent`, and queue it.

foreman's README covers its internals: how a run is set up, the autonomy
levels, the post-PR pipeline and its own configuration.

## What you need from Anthropic

foreman runs [Claude Code](https://docs.anthropic.com/en/docs/claude-code).
Either of these works:

- `ANTHROPIC_API_KEY`: an API key from the Anthropic Console, billed per
  token. The simplest choice.
- `CLAUDE_CODE_OAUTH_TOKEN`: a long-lived token from `claude setup-token`,
  which runs against a Claude subscription instead.

pinboard's budget views track spend per license (seat); set a license's
allowance in the UI to have the planner hold autonomous work back before it
runs past it.

## Configuration

`.env.example` lists every variable. The ones you are most likely to set:

| Variable | Default | What it does |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | (required) | Database password |
| `APP_PORT` | `8095` | Host port of the UI and API |
| `COMPOSE_PROFILES` | unset | `runner` starts the foreman runner too |
| `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` | unset | Claude credential for the runner |
| `GH_TOKEN` | unset | GitHub token the runner pushes and opens PRs with |
| `PINBOARD_TAG`, `FOREMAN_TAG` | `latest` | Image tags to run |
| `PINBOARD_IMAGE`, `FOREMAN_IMAGE` | `ghcr.io/rackmarten/...` | Image names, for a fork's own images |
| `PINBOARD_PUBLIC_URL` | `http://localhost:8095` | Base URL that notification links open |
| `PINBOARD_SQL_DIR`, `PINBOARD_BACKUP_DIR` | named volumes | Host paths for the database and dumps |
| `BACKUP_RETENTION_DAYS`, `BACKUP_KEEP_MIN` | `7`, `3` | Dump retention |

Optional integrations, each off until its variables are set (startup logs one
`mail:`, `push:` and `root grants:` line saying which are on):

| Integration | Variables |
| --- | --- |
| Daily digest mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `DIGEST_TO` (default: the SMTP account), `DIGEST_HOUR` |
| Phone push via [ntfy](https://ntfy.sh) | `NTFY_URL`, `NTFY_TOKEN_PINBOARD`, `NTFY_TOPIC`, `PUSH_QUIET_START`/`END`, `PUSH_DIGEST_AT`, `PUSH_TIME_ZONE` |
| Reverse-proxy root grants | `PINBOARD_PROXY_SECRET` |

There is no login screen: pinboard trusts its network. Keep it on a private
network or behind an authenticating reverse proxy, never directly on the
internet.

## This repo's own deployment

The author runs pinboard on a dedicated host with `scripts/deploy.sh` (builds
from source via `docker-compose.dev.yml`, never starts the runner) and checks
it with `scripts/healthcheck.sh`; foreman runs on a separate machine from its
own compose file.

- Hostname: `pinboard`
- Working directory: `/app`

### API reference

No auth beyond `tailnet-trust` (`@rackmarten/server-kit`) - single
user, tailnet only.

Every endpoint below lives under `/api` (the shared server-kit URL
convention): `GET /tasks/12` in this table is `GET /api/tasks/12` on the
wire, e.g. `curl -s http://pinboard:8095/api/tasks/12`. The root paths are
the PWA's pages (`/tasks/12` opens the task in a browser). `/health` stays at
the root. Old root API calls are no longer aliased.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness + DB check |
| `GET /projects` / `POST /projects` | List / create projects (`localPath` is the local checkout's path relative to `work`'s workspace root, e.g. `my-org/my-repo`; used by `work plan sync`) |
| `GET /projects/:id` / `PATCH /projects/:id` | Read / update a project |
| `GET /projects/:id/handoffs?limit=` | Latest handoffs for a project, most recent first - powers `work plan sync` |
| `GET /tasks?projectId=&status=&taskType=&executorMode=&parentTaskId=` | Filtered task list. Each row carries `parentTaskId` (from `parent`/`child` relations, `null` if none); `parentTaskId=` lists that task's children |
| `POST /tasks` | Create a task. `status`/`taskType`/`executorMode` must be known values (list in `app/src/task-model.ts`) or it's a 400; `status: "backlog"` is accepted as an alias of `defined`. Same rules on `PATCH /tasks/:id` |
| `GET /tasks/:id` | Task detail, including its labels |
| `PATCH /tasks/:id` | Update a task. When a child of a `story` task reaches `done`/`rejected` (here, via `/complete` or the pipeline) and all its siblings are too, the story moves to `done` with a `status` event from `system`/`pinboard`. A `story` is never ranked runnable by `/plan` |
| `GET /tasks/:id/comments` / `POST /tasks/:id/comments` | Task discussion thread |
| `GET /tasks/:id/root-grant` | Root grant state: `{ active, ctids, expiresAt, grantedAt, grantedBy }`. What a root proxy asks before every call |
| `POST /tasks/:id/root-grant` | Operator only (see "Root access"): `{ ttlHours? }` (default 4, max 24) grants the task's `rootScope` and queues it |
| `DELETE /tasks/:id/root-grant` | Revoke a grant now. Open to anyone |
| `GET /events?taskId=&projectId=&beforeId=&limit=&types=` | The journal: every task, project, chat and config change, newest first, keyset-paged by `beforeId`. Writes with no explicit `actorType`/`actorName` are attributed from `x-pinboard-actor: <type>:<name>`, else `x-pinboard-client: pwa` (human/operator), else `system/api`. Payloads older than 3 months are pruned nightly at 03:00; the rows stay |
| `GET /releases` | Releases view: every project with probed deploy targets, each target's deployed and default-branch sha, pending count and commits, and the project's latest Deploy-now request |
| `PUT /releases/targets/:projectId` | foreman's probe replaces a project's targets: `{ targets: [{ host, app, deployedSha, mainSha, pendingCount, pendingCommits, probeError, release?, deployedVersion? }] }` |
| `POST /releases/deploys` | One `deploy-service.sh` step finished: `{ repo, host, app?, sha?, outcome: succeeded\|failed, taskId?, requestId?, durationMs? }`, journaled as `deploy` |
| `POST /releases/:projectId/deploy` | Deploy now: queues a request (409 if one is already queued or running for that project) |
| `POST /releases/:projectId/release` | Release to production: `{ bump?: patch\|minor\|major }` (default patch) queues a `kind: release` request. 400 unless the project's probe reported a release target, 409 if any request is already queued or running for it |
| `POST /releases/requests/claim` / `POST /releases/requests/:id/finish` | foreman claims the oldest queued request, deploy or release (204 when none; a deploy running over 45 minutes or a release over 90 is failed as abandoned first) and reports `{ ok, output, version? }` |
| `GET /notifications?unread=&beforeId=&limit=` / `GET /notifications/unread-count` | Things needing attention, derived from journal events by `app/src/notifications.ts` (failures, review, approval, questions, completions; never a human's own action). Global read state, no per-operator split yet |
| `POST /notifications/:id/read` / `POST /notifications/read-all` | Mark read |
| `POST /push/test` | Publish a test notification to pinboard's ntfy topic; `{ sent: true }`, 503 when ntfy isn't configured, 502 when the publish failed |
| `POST /alerts/grafana` | Grafana webhook contact point: one task and push per alert, see "Grafana alerts" |
| `POST /tasks/:id/claim` / `POST /tasks/:id/complete` | Zero-autonomy write path - body `{actorType, actorName}`, stamps a `task_events` row. `claim` also takes an optional `leaseSeconds` (I4a's agent-runner claim) and 409s while an existing lease is still live |
| `POST /tasks/:id/reject` | I4b's review-queue reject - body `{actorType, actorName}`, moves the task back to `rework` |
| `POST /tasks/:id/control` | I4c's running-workers stop/kill - body `{actorType, actorName, action: "stop"\|"kill"}`, sets `controlAction`/`controlRequestedAt` for `foreman`'s runner to notice and act on |
| `GET /pipeline/next` | every task currently in the post-PR pipeline, with what a stateless poller needs to act - stage, when it entered it, attempt count, the project's slug/`localPath`/`autoDeployAllowed`, and the task's latest PR url/branch/repo. Oldest stage first, so a backlog drains in the order it built up. Nothing drives this yet; #154's increment 2 builds the poller |
| `POST /tasks/:id/pipeline` | advance, park or hand back one task - body `{actorType, actorName, to, repairReason?, repairContext?}`. The legal moves live in `app/src/pipeline.ts` and are checked here in one place, so a poller bug can't walk a task into a state the UI has no meaning for; an illegal move is a 409 naming what *was* allowed. A handback to `queued` requires a `repairReason` (`ci_failed`/`merge_conflict`/`deploy_failed`) and carries the evidence in `repairContext`. a handback to `queued` is refused unless the task is `executorMode: agent`; a `human+agent` task is parked in `rework` with the same `repairReason`/`repairContext`, and a later PATCH from `rework` to `queued` keeps them (any other PATCH to `queued`/`rework` clears them). Records one `pipeline` task event per transition |
| `POST /tasks/:id/handoff` | Records a `handoffs` row (usage fields, `next`, an optional markdown TL;DR `summary`, etc.) and moves the task to `handoff` - body as above plus the handoff fields and an optional `agentName` |
| `POST /tasks/:id/asks` | a run's structured ask - `{kind: "question"\|"assumption", question, context?, options: [{label, rationale?, recommended?}], defaultOption?, threadId?}`. A question needs 2-4 options with exactly one `recommended`, or none for a free-text question; an assumption needs none. A new question notifies (kind `question`) with its text as the body. `GET /tasks/:id` returns open asks and those answered in the last 7 days as `asks` |
| `GET /asks?status=open&taskId=` | Asks across all projects (newest first, max 200), each with `taskTitle`/`taskStatus`/`projectSlug`/`projectName`; `status` takes a comma list |
| `POST /asks/:id/answer` | `{option?, text?}` (a question needs one of them; an assumption answered this way is `accepted`). Posts the answer into the ask's thread (or the task's latest one) as a human message, so a session waiting in `work task ask` picks it up, and moves a `needs_input` task back to `queued` (a `root-access` task with an ended grant lands in `rework`, as with `/pipeline`). 409 once already answered |
| `POST /asks/answer-recommended` | Answers every open question with its recommended option |
| `POST /asks/:id/veto` | Assumptions only: `{text}` (required). Marks it `vetoed`, posts the veto into the thread, and moves the task to `rework` with the text as the status event's reason |
| `GET /tasks/:id/events` | The task's append-only audit trail (claim/comment/handoff/complete, each with actor provenance) |
| `GET /tasks/:id/chat-thread` | I9: the task's current session chat thread (most recently updated), 404 if none - see `GET /chat/threads?taskId=` below |
| `GET /chat/threads?projectId=&taskId=&status=&awaitingAgent=` / `POST /chat/threads` | I8/I9: chat threads - `taskId=<id>` filters to one task's session thread, `taskId=none` excludes task-scoped threads (used to keep I8's planning-chat poller and PWA list from touching them) |
| `GET /chat/threads/:id/messages` / `POST /chat/threads/:id/messages` | Thread messages - posting flips `awaitingAgent` to whichever role didn't just speak |
| `POST /chat/threads/:id/events` / `GET /chat/threads/:id/events?since=&turn=&limit=` | the live-session transcript (tool calls, text deltas, thinking, cost ticks). **With no `since`, GET returns the *newest* `limit` rows (default 500, oldest-first in the response) - the live tip.** With `since`, it replays forward from that id. returning the oldest page instead pinned a caller to a stale high-water mark, so a thread past 500 events could never reach what was happening now. POST takes a **batch** (`{events: [{kind, payload?, turn?, seq?}]}`, max 500) because a live turn emits hundreds of deltas and one request each would cost more in HTTP than in inference; GET replays from an id so reloading mid-turn doesn't lose the transcript. Every POST also trims the thread back to its 2000-event cap and reports how many rows that dropped |
| `GET /chat/threads/:id/permission-rules?turn=&includeRevoked=` / `POST` / `DELETE /chat/threads/:id/permission-rules/:ruleId` | what "don't ask again" granted, in the Claude Agent SDK's own rule shape (`{toolName, ruleContent?, behavior, scope, turn?}`) so foreman's `canUseTool` hands it straight back to the SDK - pinboard stores rules and never matches them itself. `scope: "thread"` is the real "don't ask again"; `scope: "turn"` needs a `turn` and stops applying when it ends. DELETE revokes (sets `revokedAt`), it doesn't delete |
| `POST /chat/threads/:id/permission-decision` | the operator's answer to a `permission_request` - `{requestId, behavior: "allow"\|"deny", updatedPermissions?, message?}`. Keyed by `requestId` rather than inferred from "the most recent human message after the question" (what `permission-server.ts` had to do), because that inference cannot tell two concurrent requests apart and has nowhere to carry the rule a "don't ask again" creates. `updatedPermissions` is the Agent SDK's own `PermissionUpdate[]`, passed through untouched. Recorded on the transcript and delivered on both streams |
| `POST /chat/threads/:id/question-answer` | the operator's picks for a `question` event - `{requestId, answers: {"<question text>": "<answer>"}, annotations?}`. Its own route rather than a reuse of permission-decision: an approval is allow/deny plus SDK permission updates pinboard passes through opaquely, while this is free text that ends up inside the tool's own input, so every value is validated as a string here (a non-string would reach the model as `[object Object]`, and an empty map would stop the session waiting while handing the tool the same nothing a missed question produces). `answers` is keyed by the question's own text, which is the key the SDK's `AskUserQuestion` schema uses; a multi-select answer is the chosen labels joined with a comma. Recorded on the transcript and delivered on both streams. **First answer wins**: a second POST for the same `requestId` is a 409, because foreman writes its own `question_answer` when its wait times out and a reply landing after that was never delivered to the tool call - recording it would show real-looking answers for a question the agent provably did not have |
| `GET /chat/stream?threadId=` (SSE) | foreman subscribes **outbound** and holds it open, so a human message, a new permission rule, an interrupt or a thread change reaches the live session in under a second instead of on its next poll. No inbound path to that LXC is created - the connection is always foreman's to open. Its own transcript events are filtered out. Heartbeat `: ping` every 20s |
| `GET /chat/threads/:id/stream` (SSE) | the PWA's stream for one thread - everything concerning it, transcript included, so the live transcript renders without polling |
| `POST /chat/threads/:id/interrupt` | the stop button's backend half - signals the live session on the stream (there is a session to interrupt now, not just a process to kill) and records it on the transcript. A stop delivered on the next poll has already let the tool call it meant to stop run |
| `GET /agents` / `POST /agents` | List / create agent definitions - credentials never live here, see `credentialRef` in the schema. `licenseId` is required on create (see `/licenses` below) |
| `PATCH /agents/:id` | Update an agent, including reassigning `licenseId`. Name isn't patchable |
| `GET /licenses` / `POST /licenses` / `PATCH /licenses/:id` | an account/license under a provider (e.g. a second person's Claude seat) - `{name, provider, linuxUser, tokenEnvVar?, sessionBudgetUsd?, concurrencyLimit?, enabled?}`. `tokenEnvVar` is the name of the env var on foreman holding the seat's OAuth token (e.g. `CLAUDE_OAUTH_TOKEN_PETER`), never the token itself; null means foreman's own login. `sessionBudgetUsd`/`concurrencyLimit` are nullable overrides of the appSettings-level defaults. `recurrenceEnabled`/`recurrenceBudgetUsd` turn on weekly recurring budget periods; the amount must be positive while recurrence is on (400 otherwise). Mirrors `/agents`' CRUD shape - name isn't patchable |
| `GET /labels` / `POST /labels` | List / create labels |
| `GET /plan?licenseId=` | the full work plan - period/session budgets, pacing, the 5h slot timeline, the load verdict and the cost model behind the estimates, all scoped to one license's own budget/usage. Recomputed on every read, never stored. `licenseId` defaults to the `default` license (the 0024 migration's backfill target) when omitted. Returns `concurrency: {global, seat, seatRunning}` - since a past task a license carries its own limit (nullable, inheriting the global default), so the concurrency figure is no longer one global number. `period.recurrence: {enabled, budgetUsd, nextEndsAt}` is the seat's weekly repeat; `nextEndsAt` is where the next auto-created week will end, null when off or there is no period yet. Reading the plan is what rolls a repeating seat over to its next week. The *backlog* is still shared across licenses rather than partitioned (see a past task's plan doc) - by design as of #152, since either seat taking the next unrouted task is the point |
| `GET /plan/next?licenseId=&override=` | The dispatcher-facing slice: which task(s) may start right now, or a `waitUntil` when the session window is spent but not expired (sleep rather than re-poll). `override=true` skips the budget gates only. `licenseId` defaults to the `default` license when omitted; foreman's dispatcher asks once per enabled license since a past task. `concurrency` is the asking seat's own limit, `concurrencyGlobal` the cross-seat cap and `seatRunning` what that seat already holds - both caps apply (#155) |
| `GET /plan/gate/:taskId?licenseId=&override=` | Whether one specific task may start now - what `work task run <id>` asks, as opposed to `/plan/next`'s "pick me something". Same rules, evaluated with that task as the sole candidate. Same `licenseId` default as `/plan/next`. also returns `budgetUsd`, the `--max-budget-usd` that run may spend, sized from that task's own cost estimate (2x the estimate, floored at $2 and capped at $10 - see `cost-model.ts`'s `runBudgetForEstimate`). also floored at $1 per `estimatedEffort` point (effort 5 gets $5, effort 8 gets $8, still capped at $10), since the estimate is the project mean and would otherwise give every task about $2 (`runBudgetForTask`). A task with no effort keeps the estimate-only budget. Present on refusals too, so a caller never needs a fallback constant |
| `POST /plan/session-limit` | record where Claude said the 5h session window actually resets - body `{resetsAt, licenseId?, taskId?, rawError?}`. foreman posts this after parsing `You've hit your session limit - resets <time> (UTC)` out of a failed run. This is the only ground truth pinboard gets about the boundary; everything else is inferred from spend |
| `POST /plan/session-reset` | Body `{licenseId?}`. Forget the seat's derived session spend and any session-limit report made before now, so dispatch can resume when pinboard's estimate is wrong. Returns the license |
| `GET /plan/session-limit?licenseId=` | The currently-live reported reset for a license, or `null` once it has passed. Diagnostic - the plan already folds it in - but it answers "why is the dispatcher asleep?" in one call |
| `GET /plan/periods?limit=&licenseId=` / `POST /plan/periods` | List (optionally filtered by license) / create budget periods - body `{budgetUsd, endsAt, licenseId?, startsAt?, note?}`. `licenseId` defaults to the `default` license on create; a period's license can't be changed after creation |
| `GET /plan/periods/current?licenseId=` | The period containing now for one license, 404 if none does. `licenseId` defaults to the `default` license |
| `PATCH /plan/periods/:id` | Update a period's budget, dates or note |
| `GET /settings/planner` / `PUT /settings/planner` | Session window budget, cold-start task cost and the global concurrency limit. Unset fields fall back to the `GOVERNOR_*` env defaults |
| `POST /tasks/:id/labels` / `DELETE /tasks/:id/labels/:labelId` | Assign / remove a label |

`estimatedEffort` is constrained to `1, 2, 3, 5, 8, 13` (a story-point-like
AI effort scale, not engineering time) - the I0 spike found an
unconstrained integer let the model invent a value of `1000`.

A past task: the **post-PR pipeline**. Everything
between an agent opening a PR and a human looking at the result - poll CI,
merge, deploy, healthcheck - is plain code with no judgement in it, but until
now it ran inside the agent's own session, holding a concurrency slot, a
lease and a Claude session open for the ten-plus minutes of CI polling plus
the deploy. Pinboard now owns that as state: five new `tasks.status` values
(`awaiting_ci`, `awaiting_merge`, `awaiting_review`, `deploying`,
`verifying`), a single table of legal transitions between them
(`app/src/pipeline.ts`), and the two endpoints above for a poller to read and
drive them.

They are ordinary `tasks.status` values rather than a separate column on
purpose: the governor counts concurrency with `where status = 'executing'`,
so a task entering the pipeline frees its agent slot with nothing new to
teach it. A *failed* stage is deliberately not a status - it puts the task
back to `queued` with `repair_reason`/`repair_context` set, so the existing
dispatch, gating and attempt-cap path picks it up unchanged and a repair loop
ends the same way any other retry does. `awaiting_review` is the one stage a
human releases: a diff touching a drizzle migration holds *before* merge, so
main never carries an unreviewed migration, and the review queue grew a
second kind of card for it (Approve & merge, with the PR linked) alongside
the existing after-the-fact sign-off.

A past task adds three guards:

- **Approve merges.** Approving a task in `review` that still has a PR row
  not `merged`/`closed` moves it `review -> awaiting_merge` (comment
  "Approved via review queue - merging.") so foreman merges it, instead of
  closing it over an unmerged branch. `POST /tasks/:id/complete` and
  `PATCH status=done` return 409 while such a row exists unless the body has
  `force: true` (the review queue's "Mark done without merging").
  `PATCH /tasks/:id/pull-requests/:prId` accepts `state` `open|merged|closed`
  so foreman can sync PR state; pinboard itself never calls GitHub.
- **`needs_input` status.** An agent parked on an unanswered question:
  `queued`/`executing`/`handoff -> needs_input` via `POST /tasks/:id/pipeline`, and
  back out to `queued` (operator answered, no `repairReason`, not an
  attempt), `rework` or `rejected`. Pushes "Agent needs input: #id",
  linking to `/chat/<threadId>` when the event payload carries one.
- **Readiness lint** (`app/src/readiness.ts`). Moving an
  `executorMode=agent` task into `queued` (PATCH, or create with
  `status: queued`) returns 422 `{ error, failures[] }` unless: effort is
  set and <= 8, priority > 0, autonomyLevel set, the description is >= 200
  chars with an `Acceptance`/`Done when` line, every other workspace repo it
  mentions as a path or `repo#N` is in `relatedProjectIds`, and no line
  starts with `TBD`, `?`, `Open question` or `Decide`. `force: true`
  bypasses it; the task form shows the failures and a "Queue anyway" button.
  A move from `executing` or `needs_input` is not linted: that is foreman
  handing back a task that already ran, and refusing it strands the task.

`verifying` may also move straight to `done`, for foreman to
auto-close an `executorMode=agent` task once its healthcheck passes. That
move has `/complete`'s side effects (root grant revoked, a `complete` event
for the releases history and notifications, parent story closed if this was
its last open child). The same story relaxed the `depends_on` gate: a target
in `review` with at least one PR and every PR `merged` satisfies it (its
change is already on main, only a human sign-off is left), both in
`plan.ts`'s `blockedTaskIds()` and in the PWA's "blocked by" hints (via the
relations endpoint's `otherTask.dependencySatisfied`).

Nothing drives any of this yet - foreman's poller is #154's increment 2, and
the handbacks that resume an agent are increment 3. Until then this pinboard
simply never sees a task in a pipeline status.


## Local development

    cd app
    npm install
    npm run dev

Requires a reachable Postgres (`DATABASE_URL`) - either `docker compose up
db` from the repo root, or point at any local Postgres instance.
Dependencies, `@rackmarten/server-kit` included, come from the public npm
registry.

### PWA (`app/pwa`)

    cd app/pwa
    npm install
    npm run dev

Dev mode proxies API requests to the live
pinboard instance in `app/pwa/vite.config.ts` rather than needing a local
backend too.

In production the backend serves the built PWA itself -
`app/pwa/dist` → `./public` at image build time, one container (see
`app/Dockerfile`'s `pwa-build` stage and the `spa` option in
`app/src/index.ts`). Pages use clean URLs (`/tasks/12`, vue-router web
history via ui-kit's `createHomelabRouter`): any page path the server doesn't
know as a file gets `index.html`, and an old `/#/tasks/12` link is rewritten
to `/tasks/12` at boot. The back button closes an open dialog or menu first
(ui-kit's `useBackClose`, wired into every overlay). No frontend login
screen - same `tailnet-trust` gate as the API.

### Tests

    cd app && npm test        # node:test, the server's pure modules
    cd app/pwa && npm test    # vitest, the PWA's pure modules

Both cover the logic that has no UI and no database in it - normalisation,
folding, planning, cost - so the parts most likely to be got wrong twice do
not have to be re-checked by hand. The server suite needs no live Postgres
(its `DATABASE_URL` is a placeholder that nothing connects to). The PWA suite
arrived with a past task and starts with `foldChatEvents`, the chat
transcript's event fold.

### Schema changes

    cd app
    npm run db:generate

Generates a new Drizzle migration under `app/drizzle/` from changes to
`src/db/schema.ts`. Migrations run automatically on app startup
(`src/db/migrate.ts`).


## Backups

`docker-compose.yml`'s `backup` service (`scripts/backup.sh`) runs a
nightly-ish `pg_dump` loop (dump, prune anything older than
`BACKUP_RETENTION_DAYS`, sleep 24h - not wall-clock cron), writing gzipped
dumps to `${PINBOARD_BACKUP_DIR:-/app/backups}` on the host's own disk.

Each run:

- waits for Postgres to accept connections first (the stack restarts
  together on deploys and reboots, and an immediate dump used to hit a db
  that wasn't up yet, leaving empty 20-byte files),
- dumps with `pipefail`, so a failed `pg_dump` fails the run,
- restores the dump into a scratch database (`<db>_restore_check`, dropped
  afterwards) and checks that `projects` and `tasks` row counts are non-zero
  and no higher than live,
- only then moves the file into place. A failed run leaves no file,
  retries after `BACKUP_RETRY_SECONDS` (default 15 minutes), and posts to
  `POST /backups/report`, which journals a `backup` event and raises a
  "Pinboard backup failed" notification (bell + push). Successful runs are
  journaled without a notification.

Foreman reports its own operator-attention conditions (an executor failing, a
seat logged out, the workdir disk full) the same way, to
`POST /health/report` with `{check, status: "failing"|"recovered", project?,
detail?}`: a `health` journal event and a bell entry per transition (task
#321; see foreman's README, "Operator alerts").

Pruning removes dumps older than `BACKUP_RETENTION_DAYS` but always keeps
the newest `BACKUP_KEEP_MIN` (default 3), so a streak of failures can't
age out every good copy.

`./scripts/backup-now.sh` takes one backup immediately and
exits non-zero on failure. `docker logs pinboard-backup` shows every run.

Restoring: `gunzip -c /app/backups/pinboard-<ts>.sql.gz | docker exec -i
pinboard-db psql -U pinboard -d <target db>`. Restore into a fresh database
and copy what you need across, rather than over the live one.

Copying the dumps off the machine is left to whatever backs up the host.

### Upgrading Postgres across a major version

`docker-compose.yml`'s pin (`db` and `backup` services, must move together
since `backup` runs `pg_dump`/`psql` against `db`) is on a major version, not
just a patch. A major Postgres bump changes the on-disk data format, so
pulling the new image and restarting in place crash-loops with "database
files are incompatible with server" - `scripts/deploy.sh`'s plain `pull` +
`up -d` cannot carry a major bump on its own.

`scripts/migrate-postgres-18.sh` (a past task, 16-alpine -> 18-alpine) does the
actual migration: dumps the running cluster with `pg_dump` (the same plain-SQL
format `scripts/backup.sh` already uses and already proves restores cleanly),
moves the old data directory aside (renamed, not deleted), brings up a fresh
cluster on the new image, restores the dump into it, and checks `projects`/
`tasks` row counts match before starting the rest of the stack. Run it by
hand during a maintenance window, after the version bump in
`docker-compose.yml` is already deployed - `docker compose down` briefly
stops the app. The old data directory and the dump it made are left in place
for manual cleanup once the new cluster is confirmed good.

Postgres 16 -> 18 itself carries no SQL-level breaking change expected to
affect this app (Drizzle-generated schema/queries, no reliance on removed
features) - the risk is entirely the data-format jump, which the dump/restore
step above sidesteps rather than using `pg_upgrade` in place. See
https://www.postgresql.org/docs/release/ for the full per-version release
notes if a future bump needs a closer look.

## Support this project

If pinboard saves you time, you can support its development on
[Ko-fi](https://ko-fi.com/rackmarten):

[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/rackmarten)
