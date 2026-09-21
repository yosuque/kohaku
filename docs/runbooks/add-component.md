# Runbook: adding a component to the core catalog

This is for contributing a new part to the **core catalog** (`packages/registry`) — a change to this
repository itself. If you're building a product on top of kohaku and want to add your own part, that
doesn't touch this repo's core catalog; see [docs/user-guide.md](../user-guide.md#adding-a-part)
instead. A product part is contributed via `CatalogContribution`, resolved alongside the core catalog
at runtime — it never needs a change here.

## 1. Define the component (TS)

Create `packages/registry/src/core/<part>.ts` using `defineComponent`. `present-chart.ts` is a good
model to copy. `defineComponent` fail-fasts at definition time on:

- `type` — must match dot-separated identifier segments (a single segment is also accepted): `^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$`. New core types SHOULD use a namespaced (multi-segment) name — see [spec/SPEC.md §3.1](../../spec/SPEC.md#31-componentdefinition-normative)'s type-naming convention.
- `version` — must be valid semver.
- `description` — required, non-empty. **This text is transcribed into the L1 generation prompt** as
  the LLM's selection guidance, so write it as such.
- `propsSchema` — must survive `z.toJSONSchema(schema, {unrepresentable: "throw"})`. Types like
  `z.date()` are not JSON-representable and will fail here.

Every fallback chain must terminate at `presentMarkdown`. Set `generation: "excluded"` if the part
should not appear in the L1 generation vocabulary (e.g. it depends on client-local state that L1
cannot yet emit).

## 2. Register it in the core catalog (TS)

Edit `packages/registry/src/core/index.ts` in all **three** places:

1. the `import` line,
2. the `coreCatalog.components` array,
3. the re-export list at the bottom of the file.

## 3. Re-export it from the package root (TS)

Add the export to `packages/registry/src/index.ts` as well. **This step is easy to miss**: the
component works through `coreCatalog` either way, so nothing fails locally — only a consumer
importing it by name notices. `overlayDialog` / `overlayToast` were missing from this list for a
while for exactly that reason. Check the existing list rather than assuming it is complete.

## 4. Update the fingerprint pin (TS test)

`packages/registry/test/catalog.test.ts` pins the core catalog's fingerprint to a literal hash
(`"core catalog fingerprint is pinned to ... (cross-language golden)"`). Adding a part always changes
this fingerprint. Run the test once to get the new value from the failure diff, then update the
literal in the test.

## 5. Implement the framework-free presenter (renderer-core)

Add `packages/renderer-core/src/presenters/<part>.ts` — a pure function plus view model, with no DOM
library dependency (contamination here is caught by `pnpm typecheck`, since renderer-core has no DOM
lib in its dependencies). Export it from `packages/renderer-core/src/index.ts`. Both renderers below
call into this same presenter, which is the mechanism that guarantees React/WC parity. New
user-facing text goes in `packages/renderer-core/src/messages.ts`; new design tokens go in
`packages/renderer-core/src/theme.ts`.

A new part's style function takes `SizingTokens` as its **trailing argument** (default
`= DEFAULT_SIZING`, `theme.ts`) and writes no px literals of its own — read `radius.*` / `space.*` /
`font.size.*` / `shadow.*` from the bag (React reads it via `useSizing()`; WC reads `rt.sizing`), the
same way every existing presenter style function does. Hover / active / focus-visible rules belong in
`PARTS_STATE_CSS` (`packages/renderer-core/src/design-kit.ts`), the single theme-neutral stylesheet
both renderers inject once (React: `RendererProvider`; WC: once per shadow root) — not in the
presenter's own inline style, since an inline style cannot express a pseudo-class.

## 6. Implement the React renderer

Add `packages/renderer-react/src/core/<part>.tsx`, then wire it into
`packages/renderer-react/src/core/index.tsx` in three places: the `import`, the
`.register("<type>", "<version>", Impl)` call inside `createCoreRegistry()`, and the re-export at the
bottom. Register the same major version as the catalog definition. **The root element of the
implementation must carry `data-kohaku={node.id}`** — the parity tests use this as their DOM
cross-reference key.

## 7. Implement the Web Components renderer

Add `packages/renderer-wc/src/parts/<part>.ts`, then add it to the `Map` built by
`createCoreRenderRegistry()` in `packages/renderer-wc/src/registry.ts`. Shared helpers live in
`packages/renderer-wc/src/parts/kit.ts` and `packages/renderer-wc/src/dom.ts`. If the part reads
bound data, use `mountBoundPart` (the WC counterpart to React's `useBoundData` +
`DataStateNotice`) so both renderers show the same loading/error/empty states.

## 8. Add it to the parity corpus

Add one entry to `STRUCTURAL_CORPUS` in `packages/renderer-wc/test/parity/corpus.ts`. This alone
gets the part covered by **both**
`packages/renderer-wc/test/parity/structural.test.ts` (semantic DOM equivalence, React ⇄ WC) and
`packages/renderer-wc/test/parity/a11y.test.ts` (axe-core structural accessibility, both renderers).
If the part has events, also add coverage in `events.test.ts`. If the part can't claim structural DOM
equivalence (e.g. it renders SVG, like `presentChart`), follow `chart.test.ts`'s approach instead —
semantic equivalence via `CHART_CORPUS` — rather than forcing it into `STRUCTURAL_CORPUS`.

## 9. Mirror to Python

1. Run `pnpm --filter @kohaku-ui/registry run export-core-catalog` to regenerate
   `python/kohaku/src/kohaku/registry/_data/core-catalog.json`.
2. A fallback's `mapProps` is a function and can't be JSON-serialized, so hand-port it into
   `_FALLBACK_MAP_PROPS` in `python/kohaku/src/kohaku/registry/core/__init__.py`. Omitting an entry
   here raises a `RuntimeError` at catalog-build time — you can't silently forget this one.
3. Update the fingerprint pin in `python/kohaku/tests/registry/test_fingerprint.py`. No count pin
   needs updating in `python/kohaku/tests/registry/test_catalog.py` —
   `test_loads_every_exported_component` derives the expected count from the exported catalog JSON
   itself.

## 10. Update the specification doc

Add a row to the "Core-catalog component props" table in
[docs/specification.md](../specification.md), and sync
[docs/specification.ja.md](../specification.ja.md) with the same change. `spec/SPEC.md` itself does
not enumerate individual components, so it needs no update here unless your change alters a
normative rule (in which case follow [protocol-change.md](protocol-change.md) instead).

## 11. Verify

```bash
pnpm test && pnpm typecheck
pnpm vitest run --project registry
pnpm vitest run --project renderer-core
pnpm vitest run --project renderer-react
pnpm vitest run --project renderer-wc
node cli/bin/kohaku.js component validate <definition.json>   # validates a ComponentDefinition JSON file

cd python && uv run ruff check && uv run mypy && uv run lint-imports && uv run pytest
```

## Note: blast radius

Adding a component changes the catalog fingerprint, which is a cache-key component — **every
existing compose cache entry is invalidated** the moment this ships. The catalog is also transcribed
in full into the composer's generation prompt, so composer / evals / host-rest tests can be affected
indirectly even though they don't touch the registry directly. Expect to see some of those tests move
when you land this change, and treat that as expected rather than as a regression to chase down
elsewhere.
