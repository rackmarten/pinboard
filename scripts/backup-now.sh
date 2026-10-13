#!/usr/bin/env bash
# Take one backup right now (dump + restore check + report to pinboard)
# using the running `backup` service, instead of waiting for its next loop.
# Exits non-zero if the backup failed. Run on the pinboard LXC from /app.

set -euo pipefail

cd "/app"

docker compose exec -T backup sh /backup.sh --once
ls -la /app/backups | tail -n 5
