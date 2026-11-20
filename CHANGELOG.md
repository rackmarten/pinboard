# Changelog

All notable changes to `pinboard` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each `v*` tag
publishes the container image `ghcr.io/rackmarten/pinboard` at that version.

## [Unreleased]

### Added
- `POST /session-links` records which interactive Claude Code sessions
  touched which tasks, and `GET /now` lists the stories in play right now:
  progress, running children, what each is waiting on (open questions,
  review, human tasks), the next queued child, recent sessions and their
  interactive spend, plus finished sessions whose stories are all closed.
  `POST /usage` now stores the reporting `sessionId` for that spend sum.
- `GET /tasks?view=summary` (list rows without the description, repair
  notes, root-grant and session fields), `GET /tasks?doneSince=<ISO time>`
  (done tasks finished after it) and `GET /tasks/counts` (counts by status
  and project). `GET /tasks/:id` now carries `parentTaskId`, and `q` also
  matches `#12`.
- README screenshots (dark and light task list, task detail, inbox, plan,
  governor, and two at phone width) and `scripts/screenshots.sh`, which
  regenerates them from fictional demo data: it builds a throwaway stack
  under its own compose project, seeds it through the API
  (`scripts/demo-seed.mjs`), captures with headless Chromium in the pinned
  Playwright image and tears everything down again, volumes included.
- A 30-second demo clip at the top of the README, and
  `scripts/screenshots.sh --video`, which records it from the same demo
  stack: a scripted walk through the task list, a story with its checklist
  and children, Needs you and the plan, in the dark theme at 1440x900,
  captured from Chromium's screencast and packed into a GIF with sharp.
- `GET /events` takes `since`/`until` (ISO dates, a malformed one is a 400)
  and `to=<status>`, which keeps only status transitions into that status,
  so "every task that went to rework this week, with its reason" is one
  query.
- Operator time tracking, opt-in per operator and off by default. While on,
  the PWA counts active time (tab visible, window focused, input in the last
  30 seconds) per route and module, and clicks on primary actions marked
  `data-track`, and flushes them every minute and on page hide to
  `POST /activity`. Raw events are kept 90 days, per-minute totals
  indefinitely. A new "My time" tab on the Usage view shows active minutes
  per day, top modules and features, and week-over-week "waiting on a human"
  figures derived from the journal and asks (questions answered, time in
  review, `defined` agent tasks waiting to be queued, human tasks sitting
  queued). New routes `GET`/`PUT /me/settings` and `GET /usage/my-time`.
- `PINBOARD_USER_HEADER`: behind a reverse proxy that sends
  `PINBOARD_PROXY_SECRET`, a header naming the calling person, so each
  operator gets their own journal name and tracking setting instead of the
  shared `human:operator`.
- Per-task reasoning effort with a per-project default, for foreman to run a
  task with `--effort`. Tasks take `reasoningEffort` and projects
  `defaultReasoningEffort` (`medium`, `high` or `null`, anything else is a
  400) on create and `PATCH`, and task reads return
  `effectiveReasoningEffort` (the task's own value, else the project's
  default). The PWA has a "Reasoning effort" select in the task form, shown
  on the task page (an inherited value reads "high (project)"), and a
  "Default reasoning effort" in the project form. Independent of the
  story-point effort: readiness, cost estimates and the governor ignore it.
- Playtest review mode, a per-project `reviewMode` (`standard` by default,
  or `playtest`) for projects whose review means playing a build. In a
  playtest project a task can start while its one unmerged dependency is
  still in review with an open PR. `GET /tasks/:id` then returns that
  dependency as `stackOn`, with its open PRs, so foreman can stack the
  task's branch on the PR branch. A stacked PR can't be approved until its
  parent has merged (409 `merge #<id> first`), and rejecting a parent sends
  its stacked dependents back to rework with a comment. PR rows record
  `baseBranch`, `stackedOnTaskId` and `stackedOnSha` for restacking.
- Review checklists. `POST /tasks/:id/handoff` accepts an optional
  `checklist` (array of strings); clients that send none keep working.
  `GET`/`PATCH /tasks/:id/checklist` read the latest handoff's items with
  their ticks and tick, untick or note one item. Ticks are keyed by item text,
  so they survive a new handoff wherever an item is unchanged. The review card
  in "Needs you" and the task page show the checklist as checkboxes with a
  note per item and a "3/5 checked" count, and approving with unticked items
  asks for a comment, posted on the task before the approve runs.
- `POST /api/usage` records spend reported by an interactive Claude Code
  session (`{costUsd, source: "interactive", linuxUser, sessionId}`), with the
  license resolved from its Linux user. A repeat of the same session and cost
  within a minute is stored once. Interactive spend counts toward the
  governor's calibration and shows as its own figure in the usage view, but
  never toward the period or session spend that gates dispatch.

### Changed
- Task statuses: `planned`, `handoff` and `awaiting_review` are gone and
  `executing` is now `in_progress`. `review` means one thing, a human
  approving before the change lands: a green PR held for a human (a
  migration diff, no auto-deploy, production) goes `awaiting_ci -> review`
  with a `reviewReason` the review card shows, and there is no sign-off after
  a deploy (`verifying -> done` for every executor mode, a merge with
  nothing to deploy `-> done`). A handoff no longer changes the task's
  status. Old status names are still accepted on the way in, and an older
  foreman's pipeline moves are translated, so pinboard and foreman can
  deploy in either order. Migration 0049 moves the stored rows (`handoff`
  ones to `rework`, with a comment).
- The PWA asks only for what each screen shows: lists fetch summary rows,
  the Dashboard fetches counts, the inbox only tasks done since the last
  visit, and a task's page no longer loads every task (its relation picker
  searches the server as you type). The task list's free-text box searches
  descriptions on the server, debounced. Polling pauses while the tab is
  hidden and refreshes once when it is visible again.
- API responses are much smaller on the wire. The `keywords` search index
  is no longer sent with tasks or projects (it was about 40% of the task
  list). API responses and the PWA's assets are gzip or brotli compressed
  for clients that accept it. JSON responses carry an ETag and
  `cache-control: no-cache`, so a poll that finds nothing new gets an
  empty 304 instead of the whole list again.
- Compression, ETags and the 304s now come from `@rackmarten/server-kit`
  0.11.0's `createApp`, and the PWA is served through its `spa` option
  again. The PWA's hashed `assets/` files are cached as immutable for a
  year; `index.html` is still revalidated on every load. A request body
  sent with a `Content-Encoding` header is no longer inflated.
- A task's page and the Workers view poll only the tail of a task's
  activity: `GET /tasks/:id/events` takes `type` and `limit` (the newest
  `limit` events, at most 500, oldest first), and task events are indexed
  by task. On a long-running task the page's 5-second events poll went from
  about 85 KB gzipped to 7 KB, and Workers' per-task poll from 85 KB to
  under 300 bytes. Without `limit` the route still returns everything.
  `scripts/measure-polls.sh` measures every polled endpoint's size and time.
- A run's budget is now $2 per effort point (was $1), with the ceiling
  raised from $10 to $26, so effort 3 gets $6 and effort 8 gets $16.
- Cost estimates now scale with a task's effort, on by default. A task with
  an effort is estimated at the mean cost of completed tasks at that effort
  level (5+ samples), else from an intercept + slope line fitted over all
  tasks with an effort. Tasks with no effort keep the project or global
  mean. `useEffortScaling` in `PUT /settings/planner` switches it off without
  a deploy, and `GET /plan`'s `costModel` reports the line and per-effort
  means.

### Fixed
- `scripts/smoke-public-stack.sh` created its agent with executor `claude-code`,
  which foreman never dispatches to, so the pickup check always timed out. It
  now uses `cli`, and the README quickstart says agents need executor `cli`.
  Without a GitHub token foreman stops before claiming the task, so the script
  also accepts foreman's own "started" log line as the pickup.
- The agent form's Executor was free text ("e.g. cli, api, human"), so an
  agent could be saved with a value foreman never runs and its tasks sat in
  `queued`. It is now a select of `cli` (the default), `cli-host` and `8ball`,
  each with a one-line hint, and `POST`/`PATCH /agents` reject any other
  executor with a 400. Agents saved earlier with another value still load.

## [0.1.0] - 2026-10-13

### Added
- First public release. Projects, tasks (stories, increments, `depends_on`
  ordering), comments, labels, agent definitions, per-seat budgets and a
  releases view, with a Vue/Vuetify PWA on top and the foreman runner behind
  it. One `docker compose up -d` with only a database password brings the
  stack up; mail, push notifications and other integrations stay off until
  configured.

[Unreleased]: https://github.com/rackmarten/pinboard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rackmarten/pinboard/releases/tag/v0.1.0
