// Types for node-floor.mjs, so a package that does not set `allowJs` (spec) can import it from its tests.
/** The exact version in `.node-version`, e.g. "26.12.1". Throws unless it is a plain `X.Y.Z`. */
export function readNodeVersion(repoRoot: string): string;
/** The `engines.node` range derived from `.node-version`, e.g. ">=26.12.1". */
export function nodeEnginesRange(repoRoot: string): string;
