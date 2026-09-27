---
"@kohaku-ui/storage-memory": minor
"@kohaku-ui/evals": minor
---

Add Node-free subpaths for use in a browser host (the static playground, U5): `@kohaku-ui/storage-memory/memory`
re-exports `createMemoryStoragePort` (and `MAX_SPEC_CACHE_ENTRIES`) without `createFileStoragePort`'s
`node:fs`/`node:path`/`node:crypto` dependency; `@kohaku-ui/evals/judge` re-exports `createJudge` and the
`SchemaExtractor` pieces without `FixtureLlm`'s `node:fs`/`node:path`; `@kohaku-ui/evals/replay` adds a new
`ReplayLlm` (a replay-only `LlmPort` with no filesystem access, looking up a recorded response by the same
key function as `FixtureLlm` — also newly shared as `fixtureKeyOf`/`objectFixtureKey`/`textFixtureKey`).
All three existing top-level `"."` exports are unchanged.
