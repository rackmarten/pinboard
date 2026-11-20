#!/usr/bin/env bash
# Regenerates the README screenshots in docs/screenshots/ from fictional demo
# data: builds pinboard from this checkout, brings up db + app under their
# own compose project, seeds it (scripts/demo-seed.mjs, API only), captures
# with headless Chromium in the pinned Playwright image
# (scripts/capture-screenshots.mjs) and tears the stack down again, volumes
# included, also on failure. Needs Docker with the compose plugin and
# network access to the Playwright image and the npm registry; nothing else
# is installed on the host. The build is tagged pinboard-app:local, the same
# tag docker-compose.dev.yml uses, and is left in place.
#
# Usage: scripts/screenshots.sh
#
# Environment: SCREENSHOTS_PROJECT (compose project name, default
# pinboard-screenshots), SCREENSHOTS_PORT (host port for the UI on
# 127.0.0.1, default 18096).
#
# It writes its own env file (.env.screenshots, removed afterwards), never
# reads or changes .env, and scripts/screenshots.compose.yml keeps the app
# from loading it too.
set -euo pipefail

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,/^set -euo/{s/^# \{0,1\}//p}' "$0"; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."
project="${SCREENSHOTS_PROJECT:-pinboard-screenshots}"
port="${SCREENSHOTS_PORT:-18096}"
env_file=.env.screenshots
out_dir=docs/screenshots
# Keep the npm package in step with the image: the browsers inside it are
# built for exactly this Playwright release.
playwright_version=1.65.1
playwright_image="mcr.microsoft.com/playwright:v${playwright_version}-noble"
sharp_version=0.35.5
capture="${project}-capture"

# Variables exported in the calling shell would win over the env file, and
# PINBOARD_SQL_DIR in particular would point the demo db at real data.
unset PINBOARD_SQL_DIR PINBOARD_BACKUP_DIR POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD \
  PINBOARD_IMAGE PINBOARD_TAG APP_PORT COMPOSE_FILE COMPOSE_PROFILES
compose() {
  docker compose -p "$project" --env-file "$env_file" \
    -f docker-compose.yml -f docker-compose.dev.yml -f scripts/screenshots.compose.yml "$@"
}

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- logs (failure) ---"
    compose logs --tail 80 || true
  fi
  docker rm -f "$capture" >/dev/null 2>&1 || true
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$env_file"
  exit "$status"
}
trap cleanup EXIT

umask 077
cat > "$env_file" <<EOF
POSTGRES_PASSWORD=shots-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
APP_PORT=127.0.0.1:${port}
EOF
umask 022

# A leftover stack or volume from an earlier run would keep its old
# database password and data, so start from nothing.
compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "Starting db + app (project $project, port $port)..."
compose up -d --build --wait --wait-timeout 600 app

mkdir -p "$out_dir"
echo "Seeding demo data and capturing with $playwright_image..."
# On the stack's own network, so the app is reachable whether or not the
# host port is reachable from this shell, under the alias from
# scripts/screenshots.compose.yml. Runs as the calling user so the PNGs are
# not owned by root.
docker run --rm --init --name "$capture" \
  --network "${project}_default" \
  --user "$(id -u):$(id -g)" \
  --shm-size 1g \
  -e HOME=/tmp \
  -v "$PWD/scripts:/src:ro" \
  -v "$PWD/$out_dir:/out" \
  "$playwright_image" \
  bash -euc '
    mkdir -p /tmp/shots && cd /tmp/shots
    npm init -y >/dev/null
    npm install --silent --no-audit --no-fund "playwright@$0" "sharp@$1"
    cp /src/capture-screenshots.mjs .
    node /src/demo-seed.mjs http://pinboard-demo:8095
    node capture-screenshots.mjs http://pinboard-demo:8095 /tmp/shots/out
    rm -f /out/*.png
    cp /tmp/shots/out/*.png /out/
  ' "$playwright_version" "$sharp_version"

echo "Screenshots written to $out_dir/."
