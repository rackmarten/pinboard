# Changelog

All notable changes to `pinboard` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each `v*` tag
publishes the container image `ghcr.io/rackmarten/pinboard` at that version.

## [Unreleased]

### Added
- `GET /events` takes `since`/`until` (ISO dates, a malformed one is a 400)
  and `to=<status>`, which keeps only status transitions into that status,
  so "every task that went to rework this week, with its reason" is one
  query.
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
