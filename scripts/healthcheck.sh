#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Running health check for pinboard..."

docker compose ps

HOST_PORT="$(docker compose port app 8095 | cut -d: -f2)"
BASE="http://127.0.0.1:${HOST_PORT}"
curl --fail -s -o /dev/null "${BASE}/health"

# A past task's URL convention: a page deep link gets the PWA, the JSON API
# lives under /api, and an unknown /api path is a JSON 404 (not index.html).
page="$(curl --fail -s -H "Accept: text/html" "${BASE}/tasks/1")"
[[ "${page}" == *'<div id="app"'* ]] || { echo "deep link /tasks/1 did not return the PWA"; exit 1; }
projects="$(curl --fail -s "${BASE}/api/projects")"
[[ "${projects}" == \[* ]] || { echo "/api/projects did not return a JSON list"; exit 1; }
# the inbox page and the asks list that backs its Decide section.
inbox="$(curl --fail -s -H "Accept: text/html" "${BASE}/inbox")"
[[ "${inbox}" == *'<div id="app"'* ]] || { echo "/inbox did not return the PWA"; exit 1; }
asks="$(curl --fail -s "${BASE}/api/asks?status=open")"
[[ "${asks}" == \[* ]] || { echo "/api/asks?status=open did not return a JSON list"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/no-such-route")" = "404" ] \
  || { echo "/api/no-such-route did not 404"; exit 1; }

echo "Health check passed."
