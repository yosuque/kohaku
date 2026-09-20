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

design kit: `design-system.ts` ⇄ `design_system.py` (vocabulary + fragment), `l2-generate.ts`'s
`collectUnknownKitClasses` ⇄ `l2_lint.py`; goldens in `test/design-kit.test.ts` ⇄
`tests/composer/test_design_kit.py`.

`kohaku/src/kohaku/storage/` is Python-specific (`FileStoragePort`, equivalent to sample-api's
`storage-port.ts`) — it has no dedicated TS package counterpart because on the TS side that role is
folded into the sample app.

The following are **not ported to Python** — TS-only:

- `packages/otel` (OpenTelemetry is left to the host process to wire up; out of scope for the port)
- `packages/renderer-react`, `packages/renderer-wc`, `packages/renderer-core` (no Python renderer)
- `packages/sandbox` (the L2 sandbox runtime)
- `packages/client` (the typed host client SDK)
- `packages/host-a2ui` (the A2UI-compatible profile skeleton)

Within `packages/composer`, note one deliberate, permanent structural difference: Python doesn't
split the tier ladder / single-flight / result-assembly logic (`assemble.ts` / `constants.ts` /
`observer.ts` / `refs.ts` / `single-flight.ts` / `tier-ladder.ts` / `tiers/shared.ts`) out of
`compose.py` into separate modules the way TS does — same behavior, coarser file layout by design.
This is an intentional exception to the "Layout rule" below, not debt to pay down. It does **not**
cover the rest of `tiers/`: `tiers/l1-generate.ts` and `tiers/l2-generate.ts` are mirrored 1:1 as
`composer/l1_generate.py` and `composer/l2_generate.py` (each module's docstring names the TS file
it ports) — fold a new tier module into `compose.py` and you've broken that mirror, not followed it.

**Checklist**: if you add a module to `packages/host-core`, add its Python counterpart to
`kohaku/src/kohaku/host_core/` (or record the gap in `docs/design.md`'s package table).

## Layout rule

Outside the `composer` exception noted above, the mirror is meant to be **one TS source file → one
Python module of the same name** (`initial-data.ts` → `initial_data.py`, `snapshot.ts` →
`snapshot.py`). This keeps "where does this TS change belong in Python" a mechanical lookup instead
of a judgment call. When you add a new TS file that needs a Python counterpart, add it as its own
module — don't fold it into an existing one — and update `python/README.md`'s "Structure" section
(the directory tree under "## Structure") if the new module is significant enough to list there.

This rule is **forward-looking**: it applies to new files from here on and has not been
retro-applied to the existing mirror, which was written before the rule existed. The largest
remaining merge is tracked here as **known debt** (pre-existing, not something this runbook change
is asking you to fix as a side effect of an unrelated mirror):

- `kohaku/src/kohaku/lineage/promotion/service.py` merges four TS files: `service.ts` +
  `candidate-store.ts` + `nomination.ts` + `usage.ts`. (`promotion/machine.py` is already the
  correct 1:1 mirror of `promotion/machine.ts`.)

`kohaku/src/kohaku/host_mcp/server.py` used to merge `server.ts` + `initial-data.ts` + `types.ts` +
`cache-hints.ts` as well; that debt has been paid down — `types.py`, `initial_data.py`, and
`cache_hints.py` are now their own 1:1 mirrors of `types.ts`, `initial-data.ts`, and
`cache-hints.ts` respectively, and `server.py` is a 1:1 mirror of `server.ts` (`host_mcp/fallback.py`,
`intent_tools.py`, `meta.py`, and `snapshot.py` remain the correct 1:1 mirrors of `fallback.ts`,
`intent-tools.ts`, `meta.ts`, and `snapshot.ts`). TS's `tasks.ts` (the MCP Tasks extension) is not
ported at all — see `python/README.md`'s "Known differences" section — so it has no Python
counterpart to merge into anything.

Don't let a merged file grow further while it's on this list — new logic that TS puts in a new file
should get a new Python file too, even inside an already-merged module.

This is the largest, not the only, departure from the rule — do not read this section as "1:1
except for one file." At least these packages also differ, pre-existing and out of scope for this
runbook change:

- `lineage`: `constants.ts` and `tenant-scope.ts` have no Python counterpart, and the
  `fixation/service.ts` directory is mirrored as a single flat `fixation.py`.
- `registry`: `json-schema.ts` and `from-json-schema.ts` are merged into one renamed
  `props_schema.py`.
- `spec-core`: `errors.ts` and `rest-errors.ts` are merged into one `errors.py` (its docstring
  names both TS files it ports).

`host-core`'s `intent.ts`, `allowed-actions.ts`, `action-effects.ts`, `view-recorder.ts`, and
`binding-ref.ts` used to have no dedicated Python module (their logic was inlined into
`host_rest/_routes/*.py` and `host_mcp/server.py`); that debt has also been paid down — all five now
have dedicated 1:1 Python modules under `kohaku/src/kohaku/host_core/`.

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

### The layer-direction contract is defined in three places, not two

The dependency direction (no reverse flow, A2) is defined in three independent places, and none is
derived from the others — each has to be updated by hand when a package's position in the graph
changes. Only two of the three are mechanically checked; the third is prose that nothing verifies:

1. **AGENTS.md's arrow sentence** ("Dependency direction (no reverse flow)" under "Layout
   essentials") — the prose source both mechanical checks below are meant to match. **Not
   mechanically checked** — nothing reconciles it against the other two, so it can drift silently.
2. **`spec/test/dependency-direction.test.ts`'s `LAYERS` array** — the TS-side mechanical check,
   reading each `packages/*/package.json`'s `dependencies`. Run by `pnpm test`.
3. **`python/pyproject.toml`'s `[tool.importlinter]` contracts** — the Python-side mechanical
   check, listed just above. Run by `uv run lint-imports`.

The TS and Python layer *orderings* are intentionally not identical — only the *direction* (no
reverse flow) is contracted, not a shared total order. For example, TS's `LAYERS` places `lineage`
above `host-core` (in the `sandbox | lineage | evals | host-rest | host-mcp-apps | client | otel`
layer, one layer above `host-core`), while Python's `layers` places `lineage` below `composer` (in
the `registry | intents | lineage | storage` layer, one layer below `composer`, two below
`host_core`). Both are correct for their own language's actual import graph; don't "fix" one to
match the other's ordering.

### Not yet mechanised

Two mechanical checks were suggested for this contract and deliberately deferred — they are scope
decisions for the user, not something a runbook edit should silently add:

- A test reconciling AGENTS.md's arrow sentence (item 1 above) against
  `spec/test/dependency-direction.test.ts`'s `LAYERS` array, so the prose source can't drift from
  the TS-side mechanical check unnoticed.
- A machine check of `python/README.md`'s "Structure" table (the TS-package ↔ Python-module
  correspondence referenced at the top of this runbook) against the actual `python/` tree, so a
  renamed or added module can't leave the table stale.

Until one of these is scoped and written, keep both in sync by hand when you touch the files they
would check.

## Note: `ruff` intentionally does not check naming conventions

[python/pyproject.toml](../../python/pyproject.toml)'s `[tool.ruff.lint]` sets
`select = ["E", "F", "I", "UP", "B"]` — pycodestyle/pyflakes, isort, pyupgrade, and bugbear.
Ruff's `N` (naming) rules are deliberately **not** selected: many field names in this codebase are
camelCase by design because they're wire-contract fields shared with the TS side (e.g. JSON keys that
round-trip through the cross-language golden fixtures above), not Python identifiers free to be
renamed to `snake_case`.
