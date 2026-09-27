import type { ReplayFixtures, ReplayFixtureValue } from "@kohaku-ui/evals/replay";

/**
 * Every recorded fixture file (`apps/playground/fixtures/<scenario.id>.json`), imported eagerly at build
 * time via Vite's `import.meta.glob`. Empty today (see `fixtures/README.md` — recording is postponed), and
 * automatically non-empty once `record-fixtures.ts` is actually run and its output committed: this file
 * needs no change either way, since `import.meta.glob` re-scans the directory on every build.
 */
const fixtureModules = import.meta.glob<Record<string, ReplayFixtureValue>>("../../fixtures/*.json", {
  eager: true,
  import: "default",
});

/** `<id>.json`'s `<id>` for every recorded fixture file's path, e.g. "../../fixtures/l1-trend.json" -> "l1-trend". */
function scenarioIdOf(fixturePath: string): string {
  return fixturePath.replace(/^.*\/([^/]+)\.json$/, "$1");
}

/** The set of `Scenario.id` values that have a recorded fixture file. Checked by `PlaygroundBar`'s example
 * buttons (enabled vs. "awaiting recording") and by `bootstrap-demo.ts` (skip vs. pre-warm). */
export const RECORDED_SCENARIO_IDS: ReadonlySet<string> = new Set(
  Object.keys(fixtureModules).map(scenarioIdOf),
);

/** Every recorded scenario's key -> response entries, merged into the one flat map `ReplayLlm` needs. */
export function loadFixtures(): ReplayFixtures {
  return Object.assign({}, ...Object.values(fixtureModules));
}
