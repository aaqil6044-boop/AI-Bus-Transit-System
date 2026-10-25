#!/usr/bin/env bash
set -euo pipefail

curl --fail --silent --show-error --max-time 10 \
  -H 'Content-Type: application/json' -d '{"query":"{__typename}"}' \
  http://127.0.0.1:8766/otp/gtfs/v1 >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8765/api/health
curl --fail --silent --show-error --max-time 10 http://127.0.0.1/ >/dev/null
printf '\nDeployment verification passed.\n'
