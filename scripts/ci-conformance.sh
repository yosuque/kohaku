#!/usr/bin/env bash
# One REST black-box conformance leg: start a sample host (TS sample-api or Python sales-api) on one storage
# backend, wait for it, and run the TS CLI's `conformance --rest` against it. The CI `integration` job calls
# this once per (host, storage) pair, sequentially, against the same Redis / Postgres job services the adapter
# suites use — so each pair gets its own Redis key prefix and Postgres schema, and never sees what another
# leg (or the adapter suites) left behind.
#
# Usage: scripts/ci-conformance.sh <ts|python> <file|redis|postgres>
# Expects KOHAKU_REDIS_URL / KOHAKU_POSTGRES_URL in the environment for the redis / postgres legs.
set -euo pipefail
host="$1"; storage="$2"

case "$host" in
  ts) port=8787 ;;
  python) port=8790 ;;
  *) echo "::error::unknown host '$host' (expected ts or python)"; exit 2 ;;
esac
case "$storage" in
  file | redis | postgres) ;;
  *) echo "::error::unknown storage '$storage' (expected file, redis or postgres)"; exit 2 ;;
esac

export KOHAKU_STORAGE="$storage"
KOHAKU_DATA_DIR=$(mktemp -d)
export KOHAKU_DATA_DIR
export PORT="$port"
export KOHAKU_STORAGE_KEY_PREFIX="kohaku-conformance-$host"
export KOHAKU_POSTGRES_SCHEMA="kohaku_conformance_$host"
# A redis/postgres backend requires a real capability secret (both samples refuse to start on the fixed demo
# default once storage leaves the single-process file shape) -- a CI-only value, never used outside this
# ephemeral job. The `file` leg leaves it unset, so it keeps exercising the zero-config demo default.
if [ "$storage" = "file" ]; then
  unset KOHAKU_CAPABILITY_SECRET
else
  export KOHAKU_CAPABILITY_SECRET="ci-conformance-adapters-test-secret-not-for-production-use"
fi

base="http://localhost:$port/api/kohaku"
# Legs run one after another on the same port: a server still answering here would make the readiness wait
# below succeed against the wrong host, so refuse to start instead.
if curl -sf "$base/catalog" >/dev/null 2>&1; then
  echo "::error::something is already answering on port $port before the $host/$storage leg started"; exit 1
fi

log=$(mktemp)
# Job control on: the background server gets its own process group, so the cleanup below can stop the
# wrapper (`pnpm start` / `uv run`) together with the server process it spawns.
set -m
if [ "$host" = "ts" ]; then
  pnpm --filter @kohaku-ui-sample/api start >"$log" 2>&1 &
else
  (cd python && exec uv run python -m sales_api) >"$log" 2>&1 &
fi
server_pid=$!
set +m
# Always stop the server regardless of the conformance outcome, and wait until the port is free, so the
# next leg can bind it.
cleanup() {
  kill -- "-$server_pid" 2>/dev/null || kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    curl -sf "$base/catalog" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
  echo "::warning::port $port still answers after stopping the $host/$storage server"
}
trap cleanup EXIT

scripts/wait-for-http.sh "$base/catalog" 30 "$log"
node cli/bin/kohaku.js conformance --rest "$base"
