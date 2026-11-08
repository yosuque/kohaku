import { existsSync, readdirSync, readFileSync } from "node:fs";
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
  { page: "docs/paths/mcp-apps.md", snippet: "snippets/minimal-host.ts", maxLines: 30 },
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

/**
 * Copy-paste onboarding prompts for coding agents (Claude Code / Codex / Cursor). Each prompt is a plain-text
 * file under snippets/agent-prompts/ that both the EN and JA page show verbatim in a ```text fence, so the
 * prompt a reader copies is always the one this suite checked. The prompts are English in both languages: they
 * are instructions for a model, and the repository's own API names, package names and commands are English.
 */
const PROMPTS: { page: string; prompt: string }[] = [
  { page: "docs/paths/react-dashboard.md", prompt: "snippets/agent-prompts/react-dashboard.md" },
  { page: "docs/paths/mcp-apps.md", prompt: "snippets/agent-prompts/mcp-apps.md" },
  { page: "docs/paths/full-stack.md", prompt: "snippets/agent-prompts/full-stack.md" },
  { page: "python/README.md", prompt: "snippets/agent-prompts/python-host.md" },
];

const PROMPT_MAX_LINES = 40;

/** Every fenced ```text block of a Markdown string, in order. */
function textBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

function jaPageOf(page: string): string {
  return page.replace(/\.md$/, ".ja.md");
}

describe.each(PROMPTS)("$page ⇄ $prompt (agent prompt)", ({ page, prompt }) => {
  const source = readFileSync(join(SITE_DIR, prompt), "utf8").trimEnd();

  it("is shown verbatim, once, in the EN page", () => {
    const blocks = textBlocks(readFileSync(join(REPO_ROOT, page), "utf8"));
    expect(blocks.map((b) => b.trimEnd())).toEqual([source]);
  });

  it("is shown verbatim, once, in the JA page", () => {
    const blocks = textBlocks(readFileSync(join(REPO_ROOT, jaPageOf(page)), "utf8"));
    expect(blocks.map((b) => b.trimEnd())).toEqual([source]);
  });

  it(`fits in ${PROMPT_MAX_LINES} lines`, () => {
    expect(source.split("\n").length).toBeLessThanOrEqual(PROMPT_MAX_LINES);
  });
});

/** Source roots a prompt's API names must resolve in: every package, the CLI, the Python port and its sample. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx|py)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Names that look like code but are product / prose words, or illustrative placeholders. */
const NOT_API_NAMES = new Set(["FastAPI", "sales_summary"]);

describe("agent prompts only name things that exist in this repository", () => {
  const roots = [
    ...readdirSync(join(REPO_ROOT, "packages")).map((p) => join(REPO_ROOT, "packages", p, "src")),
    join(REPO_ROOT, "cli/src"),
    join(REPO_ROOT, "python/kohaku/src"),
    join(REPO_ROOT, "python/examples"),
  ].filter((p) => existsSync(p));
  const corpus = roots
    .flatMap((r) => sourceFiles(r))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const workspacePackages = new Set<string>();
  for (const dir of ["packages", "cli", "spec"]) {
    const base = join(REPO_ROOT, dir);
    const manifests =
      dir === "packages"
        ? readdirSync(base).map((p) => join(base, p, "package.json"))
        : [join(base, "package.json")];
    for (const m of manifests) {
      if (existsSync(m))
        workspacePackages.add((JSON.parse(readFileSync(m, "utf8")) as { name: string }).name);
    }
  }

  describe.each(PROMPTS)("$prompt", ({ prompt }) => {
    const source = readFileSync(join(SITE_DIR, prompt), "utf8");

    it("every @kohaku-ui/* package is a workspace package", () => {
      const named = [...source.matchAll(/@kohaku-ui\/[a-z0-9-]+/g)].map((m) => m[0]);
      expect([...new Set(named)].filter((n) => !workspacePackages.has(n))).toEqual([]);
    });

    it("every CamelCase / camelCase / snake_case identifier is defined somewhere in the source", () => {
      const names = new Set(
        source.match(/\b(?:[A-Z][a-z0-9]+){2,}\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b/g) ??
          [],
      );
      const missing = [...names].filter(
        (n) => !NOT_API_NAMES.has(n) && !new RegExp(`\\b${n}\\b`).test(corpus),
      );
      expect(missing).toEqual([]);
    });

    it("every kohaku.<module> Python path is a module of the port", () => {
      const modules = [...source.matchAll(/\bkohaku\.([a-z_]+)/g)].map((m) => m[1] ?? "");
      const missing = modules.filter((m) => !existsSync(join(REPO_ROOT, "python/kohaku/src/kohaku", m)));
      expect(missing).toEqual([]);
    });
  });
});
