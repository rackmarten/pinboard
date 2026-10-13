#!/bin/sh
# Runs as the entrypoint of the `backup` compose service (see
# docker-compose.yml) - a nightly-ish pg_dump loop, not wall-clock
# scheduled cron. Dumps land under /backups, which is bind-mounted from
# ${PINBOARD_BACKUP_DIR:-/app/backups} on the LXC's own disk - still local
# to this LXC (PLAN.md I1b deliberately deferred the off-LXC hop to the
# BACKUP-STRATEGY.md project rather than building a bespoke one here).
#
# a dump only counts once it has been restored into a scratch
# database and its row counts checked. A failed run leaves no file behind,
# is reported to pinboard (a "backup" journal event, which notifies), and is
# retried after RETRY_SECONDS instead of waiting a whole day.
set -eu
# Not POSIX, but the backup service runs this under postgres:16-alpine's
# busybox ash, which supports it, and a failed pg_dump in a pipe must fail
# the run.
# shellcheck disable=SC3040
set -o pipefail

RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
KEEP_MIN="${BACKUP_KEEP_MIN:-3}"
RETRY_SECONDS="${BACKUP_RETRY_SECONDS:-900}"
REPORT_URL="${BACKUP_REPORT_URL:-http://app:8095/api/backups/report}"
SCRATCH_DB="${PGDATABASE}_restore_check"
# One shot (scripts/backup-now.sh) instead of the loop.
ONCE="${1:-}"

log() { echo "backup: $*"; }

report() {
  # $1 outcome, $2 detail. Best effort: a pinboard that is down must not
  # stop the next backup attempt.
  body=$(printf '{"outcome":"%s","detail":"%s"}' "$1" "$(printf '%s' "$2" | tr -d '"\\' | tr '\n' ' ' | cut -c1-500)")
  wget -q -O /dev/null --header 'Content-Type: application/json' \
    --header 'x-pinboard-actor: system:pinboard-backup' \
    --post-data "$body" "$REPORT_URL" 2>/dev/null || log "could not report '$1' to $REPORT_URL"
}

# Restarts of the whole stack (deploys, LXC reboots) start this container
# alongside db, and restart policies ignore depends_on's health condition -
# which is how the empty 20-byte dumps happened. Wait for real readiness.
wait_for_db() {
  i=0
  until pg_isready -q; do
    i=$((i + 1))
    [ "$i" -ge 60 ] && return 1
    sleep 5
  done
}

count() {
  # $1 database, $2 table
  psql -d "$1" -tAc "select count(*) from $2"
}

backup_once() {
  timestamp=$(date +%Y%m%d-%H%M%S)
  dest="/backups/pinboard-${timestamp}.sql.gz"
  tmp="${dest}.tmp"
  log "dumping to ${dest}"

  wait_for_db || { echo "database not ready after 5 minutes"; return 1; }
  pg_dump | gzip > "$tmp" || { rm -f "$tmp"; echo "pg_dump failed"; return 1; }

  # pg_dump ends every complete plain-format dump with this line.
  if ! gzip -dc "$tmp" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
    rm -f "$tmp"
    echo "dump is incomplete (no completion marker)"
    return 1
  fi

  # Restore check: load into a scratch db and compare row counts. Live
  # counts are read after the dump, so they can only be equal or higher.
  dropdb --if-exists "$SCRATCH_DB"
  createdb "$SCRATCH_DB"
  if ! gzip -dc "$tmp" | psql -q -v ON_ERROR_STOP=1 -d "$SCRATCH_DB" > /dev/null; then
    dropdb --if-exists "$SCRATCH_DB"
    rm -f "$tmp"
    echo "restore into scratch database failed"
    return 1
  fi
  summary=""
  for table in projects tasks; do
    restored=$(count "$SCRATCH_DB" "$table")
    live=$(count "$PGDATABASE" "$table")
    if [ "$restored" -eq 0 ] || [ "$restored" -gt "$live" ]; then
      dropdb --if-exists "$SCRATCH_DB"
      rm -f "$tmp"
      echo "restore check failed: $table restored=$restored live=$live"
      return 1
    fi
    summary="$summary $table=$restored"
  done
  dropdb --if-exists "$SCRATCH_DB"

  mv "$tmp" "$dest"
  echo "$(basename "$dest") $(wc -c < "$dest") bytes, restored:$summary"
}

prune() {
  # Age-based, but never below the newest KEEP_MIN dumps, so a run of
  # failures can't age out every good copy.
  ls -1t /backups/pinboard-*.sql.gz 2>/dev/null | tail -n "+$((KEEP_MIN + 1))" | while read -r f; do
    if [ -n "$(find "$f" -mtime "+${RETENTION_DAYS}")" ]; then rm -f "$f"; fi
  done
  rm -f /backups/pinboard-*.sql.gz.tmp
}

while true; do
  if out=$(backup_once 2>&1); then
    log "ok: $(echo "$out" | tail -n 1)"
    report succeeded "$(echo "$out" | tail -n 1)"
    prune
    ok=0
    delay=86400
  else
    log "FAILED: $out"
    report failed "$out"
    ok=1
    delay="$RETRY_SECONDS"
  fi
  [ "$ONCE" = "--once" ] && exit "$ok"
  sleep "$delay"
done
