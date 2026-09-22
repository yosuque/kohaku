import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SITE_DIR, "../..");

/**
 * The "first code" of each adoption path is a real, typechecked file under snippets/. The Markdown must show
 * exactly that file (so documentation code can never silently stop compiling), and it must stay short enough
 * to read on one screen — the ticket's "≤ 30 lines" promise.
 */
const SNIPPETS: { page: string; snippet: string; maxLines: number; nth?: number }[] = [
  { page: "docs/paths/react-dashboard.md", snippet: "snippets/react-dashboard-static.tsx", maxLines: 30 },
  {
    page: "docs/paths/react-dashboard.md",
    snippet: "snippets/react-dashboard-host.tsx",
    maxLines: 30,
    nth: 1,
  },
  { page: "docs/paths/mcp-apps.md", snippet: "snippets/mcp-apps.ts", maxLines: 30 },
  { page: "docs/paths/full-stack.md", snippet: "snippets/full-stack.ts", maxLines: 30 },
];

/** Every fenced ```ts / ```tsx block of a Markdown string, in order. A ```bash (or any other) fence never matches. */
function codeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```tsx?\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/** The nth (0-based) fenced ```ts / ```tsx block of a Markdown file. */
function codeBlock(markdown: string, nth: number): string {
  const blocks = codeBlocks(markdown);
  const block = blocks[nth];
  if (block == null) throw new Error(`code block #${nth} not found (found ${blocks.length})`);
  return block;
}

// `nth` makes the SNIPPETS ⇄ fence mapping positional: row N of a page expects to be its Nth ts/tsx fence.
// Nothing else enforces that a page's fence count actually matches its row count, so an edit that inserts
// (or removes) a ts/tsx fence on a page could silently make a later row compare against the wrong block.
// Guard it here, deriving the expected count from SNIPPETS itself rather than hard-coding it.
const PAGES = [...new Set(SNIPPETS.map((s) => s.page))];

describe.each(PAGES)("%s has one ts/tsx fence per SNIPPETS row", (page) => {
  const expectedCount = SNIPPETS.filter((s) => s.page === page).length;

  it(`EN page has exactly ${expectedCount} ts/tsx fenced block(s)`, () => {
    expect(codeBlocks(readFileSync(join(REPO_ROOT, page), "utf8")).length).toBe(expectedCount);
  });

  it(`JA page has exactly ${expectedCount} ts/tsx fenced block(s)`, () => {
    const jaPage = page.replace(/\.md$/, ".ja.md");
    expect(codeBlocks(readFileSync(join(REPO_ROOT, jaPage), "utf8")).length).toBe(expectedCount);
  });
});

describe.each(SNIPPETS)("$page ⇄ $snippet", ({ page, snippet, maxLines, nth }) => {
  const source = readFileSync(join(SITE_DIR, snippet), "utf8").trimEnd();

  it("is shown verbatim in the EN page", () => {
    expect(codeBlock(readFileSync(join(REPO_ROOT, page), "utf8"), nth ?? 0).trimEnd()).toBe(source);
  });

  it("is shown verbatim in the JA page", () => {
    const jaPage = page.replace(/\.md$/, ".ja.md");
    expect(codeBlock(readFileSync(join(REPO_ROOT, jaPage), "utf8"), nth ?? 0).trimEnd()).toBe(source);
  });

  it(`fits in ${maxLines} lines`, () => {
    expect(source.split("\n").length).toBeLessThanOrEqual(maxLines);
  });
});
