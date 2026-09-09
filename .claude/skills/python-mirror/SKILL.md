---
name: python-mirror
description: Use when a change to the TypeScript implementation needs to be mirrored into the Python port under python/, or when the cross-language golden fixtures or the layer-direction contract need updating.
---

The Python port (`python/`) is a hand-maintained mirror of `packages/*`, kept
wire-compatible through byte-identical canonical JSON rather than shared code.

Follow the steps in [docs/runbooks/python-mirror.md](../../../docs/runbooks/python-mirror.md). Do not duplicate them here.

Key points that are easy to miss:
- `python/README.md`'s "Structure" table is the authoritative TS-package ↔
  Python-module correspondence (e.g. `packages/spec-core` ↔
  `kohaku/src/kohaku/spec/`) — check it before guessing where a mirrored change
  belongs.
- The cross-language golden fixture,
  `spec/test/fixtures/cross-language-canonical.json`, is TS-authoritative:
  regenerate it from the TS side
  (`pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures`), never
  hand-edit it from Python.
- Python's test suite reads seed data and fixtures from `REPO_ROOT/spec` and
  `apps/sample-api/src/domain/seed` directly (see `REPO_ROOT` in
  `python/kohaku/tests/conftest.py`) — it assumes a full monorepo checkout, not
  the `python/` subtree in isolation.
- The layer-direction contract is enforced twice, independently: TS via
  `spec/test/dependency-direction.test.ts`'s `LAYERS` array, Python via
  `uv run lint-imports` against the `[tool.importlinter]` contracts in
  `python/pyproject.toml`. When a package's position in the dependency graph
  changes, update both — neither is derived from the other.

Verification:
```bash
cd python && uv run pytest && uv run mypy && uv run ruff check && uv run lint-imports
pnpm vitest run --project spec-conformance  # cross-language golden, TS side
```
