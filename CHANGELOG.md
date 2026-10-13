# Changelog

Notable changes to `pinboard`. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) (Added/Changed/
Fixed/Removed), grouped by date rather than version: `main` deploys on every
push, and tagged versions only mark published container images.

## 2026-10-13

### Added
- First public release. Projects, tasks (stories, increments, `depends_on`
  ordering), comments, labels, agent definitions, per-seat budgets and a
  releases view, with a Vue/Vuetify PWA on top and the foreman runner behind
  it. One `docker compose up -d` with only a database password brings the
  stack up; mail, push notifications and other integrations stay off until
  configured.
