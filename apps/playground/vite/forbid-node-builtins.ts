import { builtinModules } from "node:module";
import type { Plugin } from "vite";

/**
 * Node core module names Vite/Rolldown could otherwise silently try to bundle for the browser (`fs`,
 * `path`, `crypto`, `os`, …) — everything `node:module`'s own `builtinModules` list knows about, matched
 * against the specifier's first path segment so a subpath import (e.g. `fs/promises`) is caught by the `fs`
 * entry. A `node:`-prefixed specifier is always treated as forbidden regardless of this list (isForbidden).
 */
const NODE_BUILTIN_NAMES = new Set(builtinModules);

/**
 * Non-builtin packages that are just as unusable in a browser bundle and worth flagging the same way.
 * jsdom in particular: `@kohaku-ui/sandbox/smoke`'s L2 validation is written to fail open when jsdom is
 * unavailable (see its `loadJsdom`, which dynamic-imports "jsdom" through a variable specifier precisely so
 * bundlers can't see it statically — that one will *not* show up here, see the plugin doc comment below).
 * A plain top-level `import ... from "jsdom"` elsewhere would defeat that design and try to actually bundle
 * it, so it is denylisted the same way as a Node builtin.
 */
const EXTRA_DENYLIST = new Set(["jsdom"]);

function isForbidden(source: string): boolean {
  if (source.startsWith("node:")) return true;
  const head = source.split("/")[0];
  return head !== undefined && head !== "" && (NODE_BUILTIN_NAMES.has(head) || EXTRA_DENYLIST.has(head));
}

export interface ForbidNodeBuiltinsOptions {
  /**
   * "strict" (the default): throws as soon as it sees a Node-only import, naming the importer in the
   * message. This is the mode a real (production) build should run in — it always fails the build (exit
   * code 1). Note that Rolldown (this repo's `vite` is rolldown-vite) resolves modules concurrently, so a
   * single build can surface more than one of these thrown errors at once rather than exactly the first one
   * chronologically — still a hard failure either way, just not a guaranteed single-error report.
   * "audit": never throws. Records every occurrence (deduplicated by importer+source pair) and prints the
   * full list from `buildEnd`, for auditing the Node dependencies (`KOHAKU_PLAYGROUND_AUDIT=1` /
   * `pnpm run build:audit`; design.md decision 57). In this mode a matched import is marked `external` instead of erroring, so the
   * build keeps walking the rest of the module graph instead of stopping at the first hit.
   */
  mode?: "strict" | "audit";
}

export interface NodeBuiltinFinding {
  /** The specifier exactly as written at the import site (e.g. "node:crypto", "jsdom"). */
  source: string;
  /** The resolved id of the file that imports it, or undefined when Vite did not supply one (an entry). */
  importer: string | undefined;
}

/**
 * Vite plugin: detects a statically-resolvable import of a Node builtin (or another browser-incompatible
 * module such as jsdom) reachable from the playground's entry point, via `resolveId`. See
 * ForbidNodeBuiltinsOptions for what the two modes do with a match.
 *
 * Important limitation (by construction, not a bug): `resolveId` only ever sees a specifier the bundler can
 * resolve *statically*. A dynamic `import(expr)` whose specifier is a variable rather than a string literal
 * is left completely alone — it is never passed to any plugin's `resolveId` — so it will never appear in
 * either mode's findings. `@kohaku-ui/sandbox/smoke`'s jsdom / node:vm loading is deliberately written that
 * way (see its own doc comments: "to avoid TS's static resolution", "in a browser [node:vm] is undefined,
 * so the dynamic import fails -> fail-open"), so this plugin silently does not — and should not — flag it.
 * A *static* top-level import of jsdom or a Node builtin anywhere else is exactly what this plugin exists to
 * catch instead.
 */
export function forbidNodeBuiltins(options: ForbidNodeBuiltinsOptions = {}): Plugin {
  const mode = options.mode ?? "strict";
  const seen = new Set<string>();
  const findings: NodeBuiltinFinding[] = [];

  return {
    name: "kohaku:forbid-node-builtins",
    // Vite's own core resolver (vite:resolve / rolldown-vite's rolldown:vite-resolve) already
    // auto-externalizes a bare Node builtin for a client build on its own — silently succeeding with a
    // broken runtime stub instead of failing the build — and it wins the race against a "normal"-priority
    // user plugin (the first non-null `resolveId` result wins; a later plugin, including this one, is then
    // never even called for that specifier). `enforce: "pre"` puts this plugin ahead of Vite's core plugins
    // so it gets first refusal.
    enforce: "pre",
    resolveId(source, importer) {
      if (!isForbidden(source)) return null;

      const key = `${importer ?? "(entry point)"} -> ${source}`;
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({ source, importer });
      }

      if (mode === "strict") {
        throw new Error(
          `[kohaku:forbid-node-builtins] "${source}" is a Node-only module and cannot ship in the ` +
            `playground's browser bundle (imported by ${importer ?? "(entry point)"}). Run the audit ` +
            `build (KOHAKU_PLAYGROUND_AUDIT=1, i.e. \`pnpm run build:audit\`) to list every occurrence at once.`,
        );
      }

      // Audit mode: mark it external instead of throwing. The bundler does not validate an external
      // module's shape (it trusts the runtime to provide it), so this does not itself raise a "no matching
      // export" error even for a named import — it just lets the build keep walking the rest of the graph
      // so every occurrence, not only the first, ends up in `findings`.
      return { id: source, external: true };
    },
    buildEnd() {
      if (mode !== "audit" || findings.length === 0) return;
      const sorted = findings
        .slice()
        .sort(
          (a, b) => (a.importer ?? "").localeCompare(b.importer ?? "") || a.source.localeCompare(b.source),
        );
      const lines = sorted.map((f) => `  ${f.importer ?? "(entry point)"} -> ${f.source}`);
      // console.log (not just this.warn) so the list is visible even when build output is captured
      // without Rollup's own warning formatting.
      console.log(
        `\n[kohaku:forbid-node-builtins] ${findings.length} Node-only import(s) reachable from the browser bundle:\n${lines.join("\n")}\n`,
      );
    },
  };
}
