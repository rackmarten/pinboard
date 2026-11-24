#!/usr/bin/env bash
# Measures the payload of every endpoint the PWA polls: raw size, gzip size
# and the fastest of three server round trips. Read-only (GETs only).
#
#   scripts/measure-polls.sh [base-url] [task-id] [chat-thread-id]
#
# base-url defaults to http://localhost:8095. Pick the busiest real task
# (most events) and chat thread for the per-task and per-thread rows.
set -euo pipefail

BASE="${1:-http://localhost:8095}/api"
TASK="${2:?task id}"
THREAD="${3:?chat thread id}"

measure() { # <label> <interval> <path>
  local label="$1" interval="$2" path="$3" raw gz ms best=""
  raw=$(curl -s -o /dev/null -w '%{size_download}' "$BASE$path")
  gz=$(curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}' "$BASE$path")
  for _ in 1 2 3; do
    ms=$(curl -s -o /dev/null -w '%{time_total}' "$BASE$path" | awk '{printf "%d", $1 * 1000}')
    if [ -z "$best" ] || [ "$ms" -lt "$best" ]; then best="$ms"; fi
  done
  printf '| %s | %s | `%s` | %s | %s | %s |\n' "$label" "$interval" "$path" \
    "$(numfmt --to=iec --suffix=B "$raw")" "$(numfmt --to=iec --suffix=B "$gz")" "$best"
}

echo "| Caller | Interval | Endpoint | Raw | Gzip | ms |"
echo "| --- | --- | --- | --- | --- | --- |"
measure "App.vue needs-you" 30s "/asks?status=open"
measure "App.vue needs-you" 30s "/tasks?status=review&view=summary"
measure "Task list" 5s "/tasks?view=summary"
measure "Dashboard" 5s "/tasks/counts"
measure "PlanView" 5s "/licenses"
measure "PlanView (per seat)" 5s "/plan?licenseId=1"
measure "GovernorView" 5s "/governor/status"
measure "GovernorView" 5s "/governor/observations?limit=20"
measure "GovernorView" 5s "/governor/rates?limit=1"
measure "GovernorView" 5s "/governor/rate-history?limit=20"
measure "ReleasesView" 10s "/releases"
measure "ChatListView" 5s "/chat/threads?taskId=none&status=open"
measure "ChatThreadView (when stream down)" 5s "/chat/threads/$THREAD"
measure "ChatThreadView (when stream down, tail)" 5s "/chat/threads/$THREAD/events?since=999999999"
measure "ChatThreadView (first load)" once "/chat/threads/$THREAD/events"
measure "TaskDetailView" 5s "/tasks/$TASK"
measure "TaskDetailView" 5s "/tasks/$TASK/comments"
measure "TaskDetailView" 5s "/tasks/$TASK/pull-requests"
measure "TaskDetailView" 5s "/tasks/$TASK/chat-thread"
measure "TaskDetailView" 5s "/tasks/$TASK/relations"
measure "TaskDetailView" 5s "/tasks/$TASK/events?type=activity&limit=50"
measure "TaskDetailView (ReviewSection: once per task)" 5s "/tasks/$TASK/handoffs"
measure "ReviewSection (per held task)" once "/tasks/$TASK/checklist"
measure "InboxView" 15s "/asks?status=open,accepted"
measure "InboxView" 15s "/tasks?doneSince=$(date -u -d '1 day ago' +%Y-%m-%dT%H:%M:%SZ)&view=summary"
measure "ReviewSection" 5s "/tasks?status=review&view=summary"
measure "WorkersView" 5s "/tasks?status=in_progress&view=summary"
measure "WorkersView (per in_progress task)" 5s "/tasks/$TASK/events?type=activity&limit=1"
