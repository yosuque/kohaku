---
name: add-component
description: Use when adding a component to the **core** catalog in packages/registry (a contribution to this repository), which requires touching registry, renderer-core, renderer-react, renderer-wc, the parity corpus, the Python catalog mirror, and the fingerprint pins. Not for adding a product-specific part — that is documented in docs/user-guide.md.
---

A core component is defined once in `packages/registry/src/core/` but has to be
wired through both renderers, both languages, and several pinned test fixtures
before it's actually usable.

Follow the steps in [docs/runbooks/add-component.md](../../../docs/runbooks/add-component.md). Do not duplicate them here.

Key points that are easy to miss:
- `packages/registry/src/index.ts` re-exports each core component by name
  separately from `packages/registry/src/core/index.ts` — a new component can
  be added to `core/index.ts`'s `coreCatalog` and its own export list while the
  top-level package re-export is forgotten. It works through `coreCatalog`
  either way, so nothing fails locally -- only a consumer importing it by name
  notices. That is how `overlayDialog`/`overlayToast` stayed missing. Check both.
- `packages/registry/test/catalog.test.ts` pins the core catalog fingerprint
  (fnv1a64) as a literal string, and
  `python/kohaku/tests/registry/test_fingerprint.py` pins the same value as the
  cross-language golden. These two fingerprint pins need updating together.
  `python/kohaku/tests/registry/test_catalog.py`'s component-count assertion
  (`test_loads_every_exported_component`) is derived from the exported catalog
  JSON rather than a separate hardcoded count, so it needs no manual update.
- On the Python side, a fallback chain's `map_props` lives in
  `_FALLBACK_MAP_PROPS` (`python/kohaku/src/kohaku/registry/core/__init__.py`)
  — it's a hand-ported dict keyed by `fallbackType`, not derived from the JSON
  automatically. A missing entry raises `RuntimeError` at `core_catalog()`
  construction time, not at the call site that needed the fallback.
- Add one entry to `STRUCTURAL_CORPUS` in
  `packages/renderer-wc/test/parity/corpus.ts` and both the structural and a11y
  parity tests (React ⇄ Web Components) pick it up automatically — no other
  wiring needed there.
- The React implementation's root DOM element for a component must carry
  `data-kohaku={node.id}` (see any file under `packages/renderer-react/src/core/`)
  — parity and event-targeting tests rely on it.

Verification:
```bash
pnpm test && pnpm typecheck
cd python && uv run pytest && uv run mypy && uv run ruff check && uv run lint-imports
```
