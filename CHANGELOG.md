# Changelog

All notable changes to `pinboard` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each `v*` tag
publishes the container image `ghcr.io/rackmarten/pinboard` at that version.

## [Unreleased]

### Changed
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
