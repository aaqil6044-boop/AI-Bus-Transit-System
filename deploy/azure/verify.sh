#!/usr/bin/env bash
set -euo pipefail

wait_for() {
  local label=$1
  shift
  for attempt in {1..30}; do
    if "$@"; then
      return 0
    fi
    sleep 2
  done
  echo "$label did not become healthy in time." >&2
  return 1
}

wait_for "OpenTripPlanner" curl --fail --silent --show-error --max-time 10 \
  -H 'Content-Type: application/json' -d '{"query":"{__typename}"}' \
  http://127.0.0.1:8766/otp/gtfs/v1 >/dev/null
wait_for "Python application" curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:8765/api/health
wait_for "Nginx" curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1/ >/dev/null
printf '\nDeployment verification passed.\n'
