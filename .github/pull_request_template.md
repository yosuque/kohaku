## Summary

<!-- What does this change do, and why? -->

## Related issue(s)

<!-- Closes #... / Relates to #... -->

## Checklist

Mark each item done, or `N/A` if it does not apply to this change.

- [ ] `pnpm test && pnpm typecheck` pass
- [ ] Changed a Zod schema in `packages/spec-core`? → regenerated `spec/schemas` (`pnpm --filter @kohaku-ui/spec run generate-schemas`) and committed it
- [ ] Changed a core registry component? → re-exported the core catalog (`pnpm --filter @kohaku-ui/registry run export-core-catalog`), and updated the Python `_FALLBACK_MAP_PROPS` and the catalog fingerprint pin (`packages/registry/test/catalog.test.ts` and `python/kohaku/tests/registry/test_fingerprint.py`) and the hardcoded part count (`python/kohaku/tests/registry/test_catalog.py`)
- [ ] Changed canonical JSON / hash / cacheKey / the sanitize allowlist? → regenerated cross-language fixtures (`pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures`)
- [ ] Changed an intent facet? → re-emitted facet views (`pnpm intents:emit`)
- [ ] Changed the seed generator? → regenerated the seed (`pnpm seed`)
- [ ] Changed the L1/L2 prompt (`packages/composer/src/prompt.ts`)? → bumped `PROMPT_REVISION`
- [ ] Intentionally changed rendered UI output? → regenerated golden Specs (`KOHAKU_GOLDEN_UPDATE=1`) and reviewed the diff
- [ ] Changed an English document? → updated its `.ja.md` counterpart in the same change
- [ ] Decided whether the Python mirror needs updating (see `python/README.md`'s correspondence table)
- [ ] Touched the protocol (`spec/`)? → ran `node cli/bin/kohaku.js conformance --self`
