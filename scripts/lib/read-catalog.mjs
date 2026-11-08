/**
 * Parses the `catalog:` block of pnpm-workspace.yaml without a yaml dependency.
 *
 * Shared by `scripts/sync-init-versions.ts` (which projects the catalog onto `cli/src/init/versions.ts`),
 * `scripts/pack-smoke.mjs` and the `kohaku init` render test, so the three can never disagree about what
 * the catalog says. It is `.mjs` (not `.ts`) because `pack-smoke.mjs` imports it and plain node cannot load
 * TypeScript here.
 *
 * Accepted entry forms (two-space indent, one entry per line):
 *   `hono: ^4.13.8`, `"@hono/node-server": ^2.1.6`, `'quoted-key': 1.0.0`, `name: "^1 || ^2"`, and any of
 *   them followed by a ` # comment`. Blank lines and `#` comment lines inside the block are skipped.
 * Anything else inside the block (a multi-line value, a plain scalar containing spaces, a flow mapping, ...)
 * throws, naming the line number, rather than being dropped: a silently missing entry would loosen a pin
 * without any warning.
 *
 * @param {string} workspaceYamlText Contents of pnpm-workspace.yaml.
 * @returns {Map<string, string>} Package name to range string.
 * @throws {Error} When a line inside the `catalog:` block cannot be parsed.
 */
export function readCatalog(workspaceYamlText) {
  /** @type {Map<string, string>} */
  const catalog = new Map();
  let inCatalog = false;
  const lines = workspaceYamlText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inCatalog) {
      inCatalog = /^catalog:\s*(#.*)?$/.test(line);
      continue;
    }
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // The block ends at the next top-level key (a non-blank, non-comment line with no indentation).
    if (/^\S/.test(line)) break;
    const m = /^ {2}(?:"([^"]+)"|'([^']+)'|([^\s:"'#]+)):[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#"']+))[ \t]*(?:#.*)?$/.exec(
      line,
    );
    if (m == null) {
      throw new Error(`pnpm-workspace.yaml line ${i + 1}: cannot parse this catalog entry: ${line}`);
    }
    catalog.set(m[1] ?? m[2] ?? m[3], m[4] ?? m[5] ?? m[6]);
  }
  return catalog;
}
