#!/usr/bin/env bash

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

echo "Deploying pinboard from ${APP_DIR}..."

# .env alone is enough to run pinboard. It is exported here so
# the optional shared env file below can be layered on top of it.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# Optional: on the homelab LXC, ../keyring renders shared values and
# credentials (PINBOARD_PROXY_SECRET, SMTP_HOST, NTFY_URL,
# NTFY_TOKEN_PINBOARD, ...) into this file over SSH. Sourced *after* .env so
# the shared value wins over a stale local copy. Compose interpolates the app
# service's environment from this shell, which is how they reach it. Absent
# anywhere else, and then nothing here changes.
KEYRING_ENV="${KEYRING_ENV:-/app/secrets/global.env}"
if [ -f "$KEYRING_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$KEYRING_ENV"
  set +a
fi

# docker-compose.yml defaults to named volumes. A checkout that already keeps
# its data in the old host paths next to it (the homelab LXC's /app/sql and
# /app/backups) stays on them even if its .env never set these, so a deploy
# never swaps in an empty database.
if [ -z "${PINBOARD_SQL_DIR:-}" ] && [ -d "${APP_DIR}/sql" ]; then
  export PINBOARD_SQL_DIR="${APP_DIR}/sql"
fi
if [ -z "${PINBOARD_BACKUP_DIR:-}" ] && [ -d "${APP_DIR}/backups" ]; then
  export PINBOARD_BACKUP_DIR="${APP_DIR}/backups"
fi

# Unused-image prune: this LXC's disk is a small (7.8G) loop device, and old
# tagged images left behind by a base-image bump (node:20-alpine -> 26,
# postgres:16-alpine -> 18, ...) never get removed on their own, since
# switching a compose pin just adds a new tag rather than dropping the old
# one. That silently ate the disk down to ~180M free until a routine
# postgres:18-alpine pull failed mid-extract with "no space left on device"
# `-a` (not just `-f`'s dangling-only default) is needed here
# because the leftover images are still tagged, just unreferenced - matches
# A dangling-layer prune, widened for that case.
docker image prune -a -f

# This host builds pinboard from source: docker-compose.yml alone pulls the
# published image, and the dev override adds the build. The foreman runner
# in the same files stays off, since its "runner" profile is not enabled here.
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.dev.yml}"

docker compose build --pull app
docker compose pull db
docker compose up -d

echo "Deployment completed."
