# Changelog

All notable changes to `pinboard` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each `v*` tag
publishes the container image `ghcr.io/rackmarten/pinboard` at that version.

## [Unreleased]

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
