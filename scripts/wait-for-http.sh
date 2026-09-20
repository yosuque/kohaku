#!/usr/bin/env bash
# Wait until an HTTP endpoint answers 2xx/3xx, or fail after N seconds and print a log file.
# Usage: scripts/wait-for-http.sh <url> <timeout-seconds> [log-file]
set -euo pipefail
url="$1"; timeout="$2"; log="${3:-}"
for _ in $(seq 1 "$timeout"); do
  if curl -sf "$url" >/dev/null; then exit 0; fi
  sleep 1
done
echo "::error::$url did not answer within ${timeout}s"
if [ -n "$log" ] && [ -f "$log" ]; then echo "--- server log ---"; cat "$log"; fi
exit 1
