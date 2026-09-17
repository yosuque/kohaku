# Runbook: mirroring a TS change to the Python implementation

`python/` is a wire-compatible full port of the TS reference implementation (conformance
CONFORMANT — see [python/README.md](../../python/README.md)). Most changes to `packages/*` need a
hand-ported counterpart change in `python/`. This runbook is the general procedure; for a
protocol/schema change specifically use [protocol-change.md](protocol-change.md) §7, and for a new
core-catalog component use [add-component.md](add-component.md) §9.

## Directory correspondence

Taken from the "Structure" section of [python/README.md](../../python/README.md) — treat that file
as the source of truth if this table and the README ever disagree.

| TS | Python |
|---|---|
| `packages/spec-core` | `kohaku/src/kohaku/spec/` |
| `packages/registry` | `kohaku/src/kohaku/registry/` |
| `packages/data-binding` | `kohaku/src/kohaku/data_binding/` |
| `packages/intents` | `kohaku/src/kohaku/intents/` |
| `packages/llm` | `kohaku/src/kohaku/llm/` |
| `packages/composer` | `kohaku/src/kohaku/composer/` |
| `packages/lineage` | `kohaku/src/kohaku/lineage/` |
| `packages/evals` | `kohaku/src/kohaku/evals/` |
| `packages/host-core` | `kohaku/src/kohaku/host_core/` |
| `packages/host-rest` | `kohaku/src/kohaku/host_rest/` |
| `packages/host-mcp-apps` | `kohaku/src/kohaku/host_mcp/` |
| `apps/sample-api` | `examples/sales-api/` |

`kohaku/src/kohaku/storage/` is Python-specific (`FileStoragePort`, equivalent to sample-api's
`storage-port.ts`) — it has no dedicated TS package counterpart because on the TS side that role is
folded into the sample app.

The following are **not ported to Python** — TS-only:

- `packages/otel` (OpenTelemetry is left to the host process to wire up; out of scope for the port)
- `packages/renderer-react`, `packages/renderer-wc`, `packages/renderer-core` (no Python renderer)
- `packages/sandbox` (the L2 sandbox runtime)
- `packages/client` (the typed host client SDK)
- `packages/host-a2ui` (the A2UI-compatible profile skeleton)

Within `packages/composer`, note one deliberate structural difference: Python doesn't split the tier
ladder / single-flight / result-assembly logic out of `compose.py` into separate modules the way TS
does — same behavior, coarser file layout.

Within `packages/host-mcp-apps` ↔ `host_mcp/`, note a similar structural difference: what TS splits
out into `initial-data.ts` / `snapshot.ts` / the eight `register*Tool` functions, Python keeps as
private functions and closures inside `host_mcp/server.py`'s `attach_kohaku_to_mcp_server` — same
behavior, no file-level 1:1 mapping there.

**Checklist**: if you add a module to `packages/host-core`, add its Python counterpart to
`kohaku/src/kohaku/host_core/` (or record the gap in `docs/design.md`'s package table).

## Cross-language golden fixtures

The shared fixture is [spec/test/fixtures/cross-language-canonical.json](../../spec/test/fixtures/cross-language-canonical.json),
**TS-authoritative** — regenerate it with
`pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures`, never by hand.

It's verified on both sides:

- TS: `spec/test/cross-language.test.ts`
- Python: `python/kohaku/tests/spec/test_cross_language_golden.py`

The Python test reads fixtures from `REPO_ROOT / "spec"` (resolved relative to the test file's own
path) — **this only works from a full monorepo checkout**, not from the `python/` subtree in
isolation.

## Why three separate compatibility guards

Each of these is checked independently because each can drift for a different reason without the
others catching it:

1. **Canonical JSON byte-for-byte equality.** kohaku's determinism and caching guarantees rest on
   both languages producing the identical serialized bytes for the identical logical value —
   including edge cases like ES number formatting, numeric-ascending ordering of array-index-shaped
   object keys, UTF-16 code-unit sort order, and lone-surrogate escaping. A JSON serializer that is
   merely "equivalent" (same value, different bytes) would silently break hashing.
2. **Hash / cache-key equality.** `intentHash`, `specHash`, and the compose cache key are all derived
   from canonical JSON via hashing. Byte-equal JSON is necessary but not sufficient to prove the hash
   pipeline itself (which library, which encoding step) matches — this guard checks the hashes
   directly.
3. **Catalog fingerprint equality.** The core catalog's fingerprint is a cache-key component computed
   independently in each language from each language's own catalog data structure. Verifying it
   matches TS's proves the Python catalog wasn't hand-ported with a typo'd type/version/order that
   canonical-JSON and hash equality alone wouldn't exercise.

Together these three guards are what let a host mix TS and Python freely (e.g. a TS host reading a
fixation written by a Python host) without a language-specific translation layer.

## Verification

```bash
cd python && uv sync && uv run ruff check && uv run mypy && uv run lint-imports && uv run pytest
```

`lint-imports` (import-linter) enforces the layer-direction contract declared in
`[tool.importlinter]` in [python/pyproject.toml](../../python/pyproject.toml), via three contracts:

- **layers** — the total order `host_rest | host_mcp | evals` → `host_core` → `composer` →
  `registry | intents | lineage | storage` → `data_binding` → `llm | spec` (higher layers may import
  lower ones, never the reverse; `|` separates independent siblings within one layer).
- **independence** — `kohaku.registry` and `kohaku.data_binding` must not import each other (TS:
  independent same-layer siblings).
- **forbidden** — only `composer` / `evals` may import `llm`; the lower packages
  (`spec`/`registry`/`data_binding`/`intents`/`lineage`/`storage`) must not.

If you add a new Python module or introduce a cross-module import, update `[tool.importlinter]` to
match — and keep it paired with the TS side's `LAYERS` array in
`spec/test/dependency-direction.test.ts`, per [protocol-change.md](protocol-change.md) §8.

## Note: `ruff` intentionally does not check naming conventions

[python/pyproject.toml](../../python/pyproject.toml)'s `[tool.ruff.lint]` sets
`select = ["E", "F", "I", "UP", "B"]` — pycodestyle/pyflakes, isort, pyupgrade, and bugbear.
Ruff's `N` (naming) rules are deliberately **not** selected: many field names in this codebase are
camelCase by design because they're wire-contract fields shared with the TS side (e.g. JSON keys that
round-trip through the cross-language golden fixtures above), not Python identifiers free to be
renamed to `snake_case`.
