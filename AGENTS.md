# Agent Instructions

> **This repository is public.** Everything committed here, including commit
> messages, PR titles and descriptions, is world-readable. Don't name private
> hosts, services, task numbers or personal addresses; the CI leak check fails
> on them.

## Project

pinboard is the work database and human UI of the pinboard/foreman pair: a
Fastify + Drizzle API (`app/src`) and a Vue/Vuetify PWA (`app/pwa`) on
Postgres. See README.md for what it does and how it is installed.

## General rules

- Read the project documentation before making changes.
- Do not modify `.env` or other local configuration files unless explicitly requested.
- Do not commit secrets, credentials, tokens, private keys, or local configuration.
- Prefer small, focused changes and preserve existing conventions.
- Run the tests before considering a change complete:
  `cd app && npm test`, `cd app/pwa && npm test`, and both `npm run typecheck`s.
- Schema changes go through `npm run db:generate` (a new Drizzle migration),
  never a hand-edited existing migration.
- Commit subjects start with `Add:`, `Edit:`, `Fix:`, `Update:`, `Remove:`,
  `Docs:` or `DevOps:` (see CONTRIBUTING.md). Record what shipped in
  CHANGELOG.md under a dated heading.
- This repository is public: no private host names, addresses, internal
  ticket numbers or personal details in code, comments, docs or commit
  messages. CI runs a leak check (`.github/scripts/leak-check.sh`).

## Secrets

`.claude/settings.json` denies reading or editing `.env`. Do not work around
that. A new credential goes into `.env` and is referenced as `${VAR}`.

## Ownership

Never run a recursive `chown` on the checkout: the database volume, when it
is a host path, is owned by the container's own UID.

## Deployment and health

Do not deploy unless explicitly asked. `./scripts/deploy.sh` deploys a
from-source install on the current host and `./scripts/healthcheck.sh`
verifies it; `./scripts/smoke-public-stack.sh` tests the quickstart stack
end to end.
