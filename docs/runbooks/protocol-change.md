# Runbook: changing the protocol / schema

Steps for changing the Kohaku Protocol itself (the wire contract in [spec/SPEC.md](../../spec/SPEC.md))
or the Zod schemas that back it. For adding a component to the core catalog, see
[add-component.md](add-component.md) instead — that does not touch the protocol.

## 1. Update the normative text

Edit [spec/SPEC.md](../../spec/SPEC.md) (canonical, English) first, then sync
[spec/SPEC.ja.md](../../spec/SPEC.ja.md) with the same change in the same commit. English is
authoritative; the two must never drift.

## 2. Update the conformance manifest

[spec/conformance/manifest.ts](../../spec/conformance/manifest.ts) exports `REQUIREMENTS[]`, the
machine-readable pairing of every MUST/SHOULD in SPEC.md. Add or change an entry with:

- `id` — matches the requirement ID cited in SPEC.md (e.g. `SPEC-ENV-001`).
- `level` — `"MUST"` or `"SHOULD"`.
- `target` — one of `"spec" | "rest-host" | "mcp-host" | "sandbox" | "lineage"`.
- `verification` — `"blackbox"` (checked by the conformance CLI directly) or `"reference"` (an
  invariant not amenable to black-box checking; guaranteed instead by the reference
  implementation's own package tests).
- `verifiedBy` — required when `verification: "reference"`; the test file(s) that guarantee it.

If you added or removed a MUST, update the MUST-count prose in SPEC.md §7 to match.

## 3. Update the Zod schema

Edit the relevant schema in `packages/spec-core/src/schema/*.ts`. Only five of these schemas feed
JSON Schema generation — the ones imported by
[spec/scripts/generate-schemas.ts](../../spec/scripts/generate-schemas.ts):

- `UISpecSchema`
- `SpecPatchSchema`
- `FixationRecordSchema`
- `LineageEventRecordSchema`
- `PromotionStateSchema`

`packages/spec-core/src/rest-errors.ts` (`HostErrorCode`, the governance error discriminators) is
plain TypeScript, not Zod — it does not participate in JSON Schema generation and needs no
regeneration step.

## 4. Update the TS implementation and tests

Make the corresponding implementation change and add/adjust tests. Don't skip this even for a
schema-only change — the schema itself is exercised by `packages/spec-core/test/*`.

## 5. Regenerate derived artifacts

Run these **in order** — later steps can depend on earlier ones (e.g. the seed depends on nothing
here, but is listed last as a matter of habit; the cross-language fixtures depend on the schema and
catalog being final):

| Command | Output | Regenerate when you changed |
|---|---|---|
| `pnpm --filter @kohaku-ui/spec run generate-schemas` | `spec/schemas/*.json` (the 5 files above) | a spec-core Zod schema in the list above |
| `pnpm --filter @kohaku-ui/registry run export-core-catalog` | `python/kohaku/src/kohaku/registry/_data/core-catalog.json` | `packages/registry/src/core/*` |
| `pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures` | `spec/test/fixtures/cross-language-canonical.json` | canonical JSON, hashing (`intentHash` / `specHash` / `structureHash`), cache-key construction, or the sandbox DOM allowlists (`ALLOWED_TAGS` / `ALLOWED_ATTRS` / `ALLOWED_STYLE_PROPS` in `packages/spec-core/src/schema/sandbox-dom.ts`) |
| `pnpm intents:emit` | `apps/sample-web/src/generated/facet-views.json` | facets in `apps/sample-api/src/intents/catalog.ts` |
| `pnpm seed` | `apps/sample-api/src/domain/seed/` | `apps/sample-api/scripts/generate-seed.ts` |

`spec/schemas/*.json` is a published contract that no code in this repo reads back — nothing will
fail locally if you forget to regenerate it. **CI's drift check is the only thing that catches a
stale `spec/schemas/`,** so always run `generate-schemas` yourself after a schema change rather than
relying on CI to notice.

## 6. Hand-maintained example: `spec/examples/quarterly-sales.spec.json`

This file is not generated — it's a hand-written canonical example, read by both
[spec/conformance/spec-format.ts](../../spec/conformance/spec-format.ts) (TS) and
`python/kohaku/tests/conftest.py` (Python, via `REPO_ROOT / "spec/examples/..."`). If your protocol
change alters the Spec format, update this file by hand to match.

## 7. Mirror to Python

Follow [python-mirror.md](python-mirror.md) for the general procedure. For a schema change
specifically: Zod → Pydantic is a hand port (`python/kohaku/src/kohaku/spec/models.py` and
neighboring modules) — the Python side does not read the generated `spec/schemas/*.json` at
runtime, so regenerating those JSON files does not by itself update Python.

## 8. If you touched cross-layer imports

Adding a new package, or a new import that crosses the documented dependency direction, needs three
files updated **together**:

- `spec/test/dependency-direction.test.ts` — the `LAYERS` array (TS side).
- `python/pyproject.toml` — the `[tool.importlinter]` contracts (Python side).
- [AGENTS.md](../../AGENTS.md) — the "Layout essentials" dependency-direction prose.

## 9. Verify

```bash
pnpm test && pnpm typecheck
node cli/bin/kohaku.js conformance --self

# REST black-box (TS)
KOHAKU_DATA_DIR=$(mktemp -d) PORT=8787 pnpm --filter @kohaku-ui-sample/api start
node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku

# REST black-box (Python)
cd python && KOHAKU_DATA_DIR=$(mktemp -d) PORT=8790 uv run python -m sales_api
node cli/bin/kohaku.js conformance --rest http://localhost:8790/api/kohaku

# Python suite
cd python && uv run ruff check && uv run mypy && uv run lint-imports && uv run pytest
```

## 10. Sync documentation

Update whichever of these describe the changed behavior, keeping each `.ja.md` counterpart in sync
in the same change:

- [docs/design.md](../design.md) / [docs/design.ja.md](../design.ja.md)
- [docs/specification.md](../specification.md) / [docs/specification.ja.md](../specification.ja.md)
- [docs/user-guide.md](../user-guide.md) / [docs/user-guide.ja.md](../user-guide.ja.md)
- [python/README.md](../../python/README.md) / [python/README.ja.md](../../python/README.ja.md)
