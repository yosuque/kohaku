/**
 * Parses the `catalog:` block of pnpm-workspace.yaml without a yaml dependency.
 *
 * Shared by `scripts/sync-init-versions.ts` (which projects the catalog onto `cli/src/init/versions.ts`),
 * `scripts/pack-smoke.mjs` and the `kohaku init` render test, so the three can never disagree about what
 * the catalog says. Catalog lines look like `  hono: ^4.13.8` or `  "@hono/node-server": ^2.1.6` (scoped
 * names are quoted); comment lines and blank lines inside the block are skipped.
 *
 * @param {string} workspaceYamlText Contents of pnpm-workspace.yaml.
 * @returns {Map<string, string>} Package name to range string.
 */
export function readCatalog(workspaceYamlText) {
  /** @type {Map<string, string>} */
  const catalog = new Map();
  let inCatalog = false;
  for (const line of workspaceYamlText.split("\n")) {
    if (!inCatalog) {
      inCatalog = /^catalog:\s*$/.test(line);
      continue;
    }
    // The block ends at the next top-level key (a non-blank, non-comment line with no indentation).
    if (/^\S/.test(line) && !line.startsWith("#")) break;
    const m = /^\s{2}"?([^":\s]+)"?:\s*(\S+)\s*$/.exec(line);
    if (m != null) catalog.set(m[1], m[2].replace(/^"(.*)"$/, "$1"));
  }
  return catalog;
}
