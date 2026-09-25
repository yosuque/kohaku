import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Every ```bash fenced block of a Markdown string, in order.
 */
function bashBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/**
 * Every ```ts / ```tsx fenced block of a Markdown string, in order (mirrors snippets.test.ts's codeBlocks,
 * duplicated here rather than imported so this file stays a single self-contained guard).
 */
function tsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```tsx?\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/** The package names named on an `npm install` / `pnpm add` / `yarn add` line, anywhere in the page's bash fences. */
function installedPackages(markdown: string): Set<string> {
  const pkgs = new Set<string>();
  for (const block of bashBlocks(markdown)) {
    for (const line of block.split("\n")) {
      const m = line.match(/^\s*(?:npm|pnpm|yarn)\s+(?:install|add|i)\s+(.+)$/);
      if (m == null) continue;
      for (const token of m[1].trim().split(/\s+/)) {
        if (token.length > 0 && !token.startsWith("-")) pkgs.add(token);
      }
    }
  }
  return pkgs;
}

/** Every package a `node node_modules/<pkg>/...` invocation in the page's bash fences names. */
function nodeModulesPackages(markdown: string): Set<string> {
  const pkgs = new Set<string>();
  for (const block of bashBlocks(markdown)) {
    for (const m of block.matchAll(/node_modules\/(@[^/\s]+\/[^/\s]+|[^/\s]+)/g)) pkgs.add(m[1]);
  }
  return pkgs;
}

/** Every bare (non-relative, non-builtin) package specifier a page's ts/tsx fences import from. */
function importedPackages(markdown: string): Set<string> {
  const pkgs = new Set<string>();
  for (const block of tsBlocks(markdown)) {
    for (const m of block.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
      const spec = m[1] ?? "";
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      const parts = spec.split("/");
      const pkg = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
      pkgs.add(pkg);
    }
  }
  return pkgs;
}

/**
 * A snippet whose import isn't installed, or whose scaffold command reaches into a package the page never
 * installed, dies on the reader's first run (I-2: `node node_modules/@kohaku-ui/cli/...` with no
 * `@kohaku-ui/cli` in the `npm install` line above it). Nothing else in the suite reads the bash fences —
 * the byte-equality guard in snippets.test.ts covers ts/tsx fences only.
 */
const PAGES = [
  "docs/paths/mcp-apps.md",
  "docs/paths/mcp-apps.ja.md",
  "docs/paths/full-stack.md",
  "docs/paths/full-stack.ja.md",
  "docs/paths/react-dashboard.md",
  "docs/paths/react-dashboard.ja.md",
];

describe.each(PAGES)("%s: install line covers what the page runs", (page) => {
  const markdown = readFileSync(join(REPO_ROOT, page), "utf8");
  const installed = installedPackages(markdown);

  it("every package a ts/tsx fence imports appears in an npm/pnpm/yarn install line on the page", () => {
    const missing = [...importedPackages(markdown)].filter((p) => !installed.has(p));
    expect(missing).toEqual([]);
  });

  it("every node_modules/<pkg> path a bash fence executes names a package in an install line on the page", () => {
    const missing = [...nodeModulesPackages(markdown)].filter((p) => !installed.has(p));
    expect(missing).toEqual([]);
  });
});
