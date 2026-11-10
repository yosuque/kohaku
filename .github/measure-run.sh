#!/usr/bin/env bash
# MEASUREMENT ONLY (never merge): one coverage run under the configuration named by $CFG.
set -euo pipefail
echo "MEASURE cfg=$CFG"
case "$CFG" in
  default) pnpm test:coverage ;;
  w4) VITEST_MAX_WORKERS=4 pnpm test:coverage ;;
  # The exact change of the earlier experiment (commit ed95bbbc): `pool: "threads"` in the root config.
  threadscfg)
    sed -i 's/^  test: {$/  test: {\n    pool: "threads",/' vitest.config.ts
    grep -n 'pool: "threads"' vitest.config.ts
    pnpm test:coverage
    git checkout -- vitest.config.ts
    ;;
  threadsw4) VITEST_MAX_WORKERS=4 pnpm test:coverage --pool=threads ;;
  *) echo "unknown CFG: $CFG" >&2; exit 2 ;;
esac
