#!/usr/bin/env bash
# Smoke test for the documented quickstart: brings up db + pinboard + the
# foreman runner from this checkout, checks both health paths, creates a task
# through pinboard's API and waits for foreman to pick it up, then tears the
# whole stack down again (volumes included).
#
# Usage: scripts/smoke-public-stack.sh [--build | --image]
#
#   --build  build both images from source (docker-compose.dev.yml); needs a
#            foreman checkout at ../foreman or FOREMAN_SRC. The default.
#   --image  pull the published images (PINBOARD_TAG/FOREMAN_TAG, default
#            latest) instead.
#
# Environment: SMOKE_PROJECT (compose project name, default pinboard-smoke),
# SMOKE_PORT (host port for the UI, default 18095), PICKUP_TIMEOUT (seconds
# to wait for foreman, default 180), ANTHROPIC_API_KEY (optional: pickup is
# what is checked, so a placeholder is used when unset).
#
# It writes its own env file (.env.smoke, removed afterwards) and never reads
# or changes .env.
set -euo pipefail

mode=build
case "${1:-}" in
  ""|--build) mode=build ;;
  --image) mode=image ;;
  -h|--help) sed -n '2,/^set -euo/{s/^# \{0,1\}//p}' "$0"; exit 0 ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/.."
project="${SMOKE_PROJECT:-pinboard-smoke}"
port="${SMOKE_PORT:-18095}"
timeout="${PICKUP_TIMEOUT:-180}"
env_file=.env.smoke
base="http://app:8095"

files=(-f docker-compose.yml)
[ "$mode" = build ] && files+=(-f docker-compose.dev.yml)
compose() { docker compose -p "$project" --env-file "$env_file" "${files[@]}" "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- logs (failure) ---"
    compose logs --tail 80 || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$env_file"
  exit "$status"
}
trap cleanup EXIT

umask 077
cat > "$env_file" <<EOF
POSTGRES_PASSWORD=smoke-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
COMPOSE_PROFILES=runner
APP_PORT=${port}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-smoke-placeholder}
DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3 || echo 991)
EOF

# A leftover stack or volume from an earlier run would keep its old
# database password, so start from nothing.
compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "Starting the stack ($mode, project $project, port $port)..."
if [ "$mode" = build ]; then
  compose up -d --build --wait --wait-timeout 600
else
  compose pull
  compose up -d --wait --wait-timeout 300
fi

# API calls go through the foreman container: it has curl and node, it is
# the path the runner itself uses, and it works where the host port is not
# reachable from the calling shell (a sandboxed CI or agent session).
api() { compose exec -T foreman curl --fail -s -H 'content-type: application/json' "$@"; }
json() { compose exec -T foreman node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval("v"+process.argv[1]))})' "$1"; }

echo "pinboard /health..."
api "${base}/health" | grep -q '"ok"' || { echo "pinboard /health is not ok"; exit 1; }
if curl --fail -s -m 5 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  echo "UI port ${port} answers on the host."
else
  echo "note: http://127.0.0.1:${port} is not reachable from this shell (fine inside a sandboxed session)."
fi

echo "foreman health (work task list against pinboard)..."
compose exec -T foreman work task list >/dev/null

echo "Creating an agent, a project and a queued task..."
license_id="$(api "${base}/api/licenses" | json '[0].id')"
api -X POST "${base}/api/agents" -d "{\"name\":\"smoke-agent\",\"role\":\"general\",\"provider\":\"anthropic\",\"model\":\"sonnet\",\"executor\":\"cli\",\"autonomyLevel\":3,\"licenseId\":${license_id}}" >/dev/null
# The planner runs nothing without a budget period covering now.
ends_at="$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)"
api -X POST "${base}/api/plan/periods" -d "{\"budgetUsd\":5,\"endsAt\":\"${ends_at}\",\"licenseId\":${license_id}}" >/dev/null
project_id="$(api -X POST "${base}/api/projects" -d '{"slug":"smoke","name":"Smoke","localPath":"smoke/smoke"}' | json '.id')"
# The description has to pass pinboard's readiness lint (200+ characters and
# an acceptance line) for an agent task to be allowed into queued.
desc="Created by scripts/smoke-public-stack.sh to check that the foreman runner picks up a queued task from pinboard. It does not need to succeed: the run has no repository to clone, and the stack is torn down right after pickup.\\nAcceptance: foreman claims the task."
task_id="$(api -X POST "${base}/api/tasks" -d "{\"projectId\":${project_id},\"title\":\"Smoke test task\",\"description\":\"${desc}\",\"status\":\"queued\",\"executorMode\":\"agent\",\"autonomyLevel\":1,\"priority\":3,\"estimatedEffort\":1}" | json '.id')"
echo "Task ${task_id} queued; waiting up to ${timeout}s for foreman to pick it up..."

deadline=$((SECONDS + timeout))
while :; do
  task="$(api "${base}/api/tasks/${task_id}")"
  status="$(printf '%s' "$task" | json '.status')"
  comments="$(api "${base}/api/tasks/${task_id}/comments" 2>/dev/null || echo '[]')"
  if [ "$status" != queued ] || printf '%s' "$comments" | grep -q 'Attempt 1'; then
    echo "foreman picked up task ${task_id} (status now: ${status})."
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "foreman did not pick up task ${task_id} within ${timeout}s (status: ${status})"
    exit 1
  fi
  sleep 5
done

echo "Smoke test passed."
