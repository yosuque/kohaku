#!/usr/bin/env bash
# MEASUREMENT ONLY (never merge): one coverage run under the configuration named by $CFG.
set -euo pipefail
echo "MEASURE cfg=$CFG"
case "$CFG" in
  default) pnpm test:coverage ;;
  w4) VITEST_MAX_WORKERS=4 pnpm test:coverage ;;
  threads) pnpm test:coverage --pool=threads ;;
  *) echo "unknown CFG: $CFG" >&2; exit 2 ;;
esac
