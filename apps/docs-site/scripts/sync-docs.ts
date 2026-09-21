/**
 * Mirrors the repository's Markdown documentation into `.generated/` (the VitePress srcDir).
 * Runs before every `vitepress dev` / `vitepress build`. The output is gitignored; nothing here is
 * hand-edited, so the Markdown in docs/ stays the single source of truth.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listMirrorSources, planMirror, rewriteLinks } from "../src/mirror.js";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SITE_DIR, "../..");
const OUT_DIR = join(SITE_DIR, ".generated");

rmSync(OUT_DIR, { recursive: true, force: true });

const sources = listMirrorSources(REPO_ROOT);
const mirrored = new Set(sources);
let pages = 0;
let assets = 0;
for (const entry of planMirror(sources)) {
  const dest = join(OUT_DIR, entry.target);
  mkdirSync(dirname(dest), { recursive: true });
  if (entry.kind === "asset") {
    copyFileSync(join(REPO_ROOT, entry.source), dest);
    assets += 1;
    continue;
  }
  const markdown = readFileSync(join(REPO_ROOT, entry.source), "utf8");
  writeFileSync(dest, rewriteLinks(markdown, entry, mirrored), "utf8");
  pages += 1;
}

// The site's landing pages are site chrome, not documentation; they live next to this script.
for (const [from, to] of [
  ["home/index.md", "index.md"],
  ["home/ja/index.md", "ja/index.md"],
] as const) {
  const dest = join(OUT_DIR, to);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(SITE_DIR, from), dest);
}

console.log(`docs-site sync: ${pages} pages, ${assets} assets → ${OUT_DIR}`);
