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
];

/** The nth (0-based) fenced ```ts / ```tsx block of a Markdown file. */
function codeBlock(markdown: string, nth: number): string {
  const blocks = [...markdown.matchAll(/```tsx?\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  const block = blocks[nth];
  if (block == null) throw new Error(`code block #${nth} not found (found ${blocks.length})`);
  return block;
}

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
