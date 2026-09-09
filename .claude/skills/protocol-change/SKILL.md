---
name: protocol-change
description: Use when changing the Kohaku Protocol or any Zod schema in packages/spec-core — SPEC.md, the conformance manifest, wire types, canonical JSON, hashes, or cache keys. Walks the full regeneration chain (JSON Schema, cross-language fixtures, core catalog, facet views, seed), the Python mirror, and the conformance checks.
---

Changing the wire protocol touches five generated artifacts, a hand-ported Python
schema layer, and two conformance suites — miss one and it only surfaces as a CI
drift failure, not a local test failure.

Follow the steps in [docs/runbooks/protocol-change.md](../../../docs/runbooks/protocol-change.md). Do not duplicate them here.

Key points that are easy to miss:
- Regenerate in this order: `generate-schemas` → `export-core-catalog` →
  `generate-cross-language-fixtures` → `pnpm intents:emit` → `pnpm seed`. A later
  step can depend on an earlier one's output.
- `spec/schemas/*.json` is not imported by any runtime code (TS or Python) — it
  exists only for external consumers and CI's drift check. Forgetting to
  regenerate it produces no local test failure at all.
- Update `spec/SPEC.ja.md` in the same change as `spec/SPEC.md` — the two must
  stay in sync.
- The Zod schema in `packages/spec-core` has no automated bridge to Python:
  `python/kohaku/src/kohaku/spec/` is a hand port, and Python does not read
  `spec/schemas`'s JSON at all. A schema change must be re-implemented by hand
  on the Python side.

Verification:
```bash
pnpm test && pnpm typecheck
node cli/bin/kohaku.js conformance --self
cd python && uv run pytest && uv run mypy && uv run ruff check && uv run lint-imports
```
