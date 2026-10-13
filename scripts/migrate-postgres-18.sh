#!/usr/bin/env bash
# One-shot data migration for the postgres 16-alpine -> 18-alpine bump
# A major Postgres version changes the on-disk data format,
# so pulling the new image and restarting in place would just crash-loop
# with "database files are incompatible with server" - this dumps the old
# cluster with plain-SQL pg_dump (already how scripts/backup.sh works and
# already proven to restore cleanly, see README's "Backups"), moves the old
# data directory aside instead of deleting it, brings up a fresh 18 cluster,
# and restores into it. Run by hand, on the pinboard LXC, during a
# maintenance window - docker-compose.yml's `db`/`backup` images must
# already be bumped to 18-alpine (this script assumes that's already
# committed and pulled) before it runs, since it relies on `docker compose
# up -d db` picking up the new image.
set -euo pipefail

cd "/app"

PGUSER="${POSTGRES_USER:-pinboard}"
PGDATABASE="${POSTGRES_DB:-pinboard}"
SQL_DIR="${PINBOARD_SQL_DIR:-/app/sql}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DUMP="/tmp/pinboard-pg18-migration-${TIMESTAMP}.sql.gz"
OLD_DATA_DIR="${SQL_DIR}.pg16-${TIMESTAMP}"

log() { echo "migrate: $*"; }

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

log "checking current db is up and is still 16.x"
current_version="$(docker exec pinboard-db psql -U "$PGUSER" -d "$PGDATABASE" -tAc 'show server_version;')"
case "$current_version" in
  16.*) ;;
  *) echo "expected a running 16.x server, found '${current_version}' - already migrated?"; exit 1 ;;
esac

log "recording live row counts for the post-restore check"
declare -A live_counts
for table in projects tasks; do
  live_counts["$table"]="$(docker exec pinboard-db psql -U "$PGUSER" -d "$PGDATABASE" -tAc "select count(*) from ${table}")"
done

log "dumping the 16.x cluster to ${DUMP}"
docker exec pinboard-db pg_dump -U "$PGUSER" -d "$PGDATABASE" | gzip > "$DUMP"
if ! gzip -dc "$DUMP" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
  echo "dump is incomplete (no completion marker) - aborting before touching the data directory"
  exit 1
fi

log "stopping the stack"
docker compose down

log "moving the 16.x data directory aside to ${OLD_DATA_DIR} (not deleted - manual cleanup once the restore is verified)"
mv "$SQL_DIR" "$OLD_DATA_DIR"

log "starting a fresh 18.x db (initializes an empty cluster in ${SQL_DIR})"
docker compose up -d db
for _ in $(seq 1 30); do
  if docker exec pinboard-db pg_isready -U "$PGUSER" -d "$PGDATABASE" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec pinboard-db pg_isready -U "$PGUSER" -d "$PGDATABASE"

log "restoring the dump into the fresh 18.x cluster"
gzip -dc "$DUMP" | docker exec -i pinboard-db psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDATABASE" > /dev/null

log "verifying row counts match what was live before the dump"
for table in projects tasks; do
  restored="$(docker exec pinboard-db psql -U "$PGUSER" -d "$PGDATABASE" -tAc "select count(*) from ${table}")"
  live="${live_counts[$table]}"
  if [ "$restored" != "$live" ]; then
    echo "row count mismatch on ${table}: restored=${restored} live-before-dump=${live}"
    echo "the old data directory is still intact at ${OLD_DATA_DIR} - stop and investigate before going further"
    exit 1
  fi
  log "  ${table}: ${restored} rows (matches)"
done

log "starting the rest of the stack"
docker compose up -d

log "done. server is now:"
docker exec pinboard-db psql -U "$PGUSER" -d "$PGDATABASE" -tAc 'show server_version;'
log "run ./scripts/healthcheck.sh next. Once satisfied, remove the old data directory: rm -rf ${OLD_DATA_DIR}"
log "dump kept at ${DUMP} until you remove it by hand"
