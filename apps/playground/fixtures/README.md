# Playground fixtures

Empty today — recording fixtures with a real LLM is postponed (see `reports/u5-3.md`; `scripts/record-fixtures.ts`
is written but has never been run). This directory is where `record-fixtures.ts` writes its output, and
`src/host/fixtures.ts` reads it back at build time via Vite's `import.meta.glob`, so a recorded scenario
becomes available with no code change once its file lands here.

One file per scenario (`src/scenarios.ts`'s `Scenario.id`), named `<id>.json`: a flat
`Record<key, ReplayFixtureValue>` (`@kohaku-ui/evals/replay`'s shape) of every LLM call that scenario needs.
A scenario may need more than one entry — e.g. an NL scenario needs the intent-normalization call and, if the
resolved Intent is L1, the draft-generation call too.

`src/host/fixtures.ts`'s `RECORDED_SCENARIO_IDS` is exactly the set of `<id>` values with a file present here;
`src/PlaygroundBar.tsx`'s example buttons and `test/drift/fixtures-drift.test.ts` both key off that set to
tell a recorded scenario apart from one still "awaiting recording".
