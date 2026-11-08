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
const PROMPTS: { page: string; prompt: string; lang: "ts" | "py" }[] = [
  { page: "docs/paths/react-dashboard.md", prompt: "snippets/agent-prompts/react-dashboard.md", lang: "ts" },
  { page: "docs/paths/mcp-apps.md", prompt: "snippets/agent-prompts/mcp-apps.md", lang: "ts" },
  { page: "docs/paths/full-stack.md", prompt: "snippets/agent-prompts/full-stack.md", lang: "ts" },
  { page: "python/README.md", prompt: "snippets/agent-prompts/python-host.md", lang: "py" },
];

/** 40 held for the first round; the mandatory auth / secret / `--intent` / L0 requirements need up to 45. */
const PROMPT_MAX_LINES = 45;

/** The body of a prompt's `HEADING` section (sections are blank-line-separated blocks led by an ALL-CAPS line). */
function section(prompt: string, heading: string): string | null {
  const block = prompt
    .trimEnd()
    .split(/\n\n(?=[A-Z][A-Z ]+\n)/)
    .find((b) => b.startsWith(`${heading}\n`));
  return block == null ? null : block.slice(heading.length + 1);
}

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

  it("has every section, and ends with a conformance check against the prompt's own Intent", () => {
    for (const heading of ["GOAL", "INSTALL", "RULES", "STEPS", "DONE WHEN"]) {
      expect(section(source, heading), heading).not.toBeNull();
    }
    const done = section(source, "DONE WHEN") ?? "";
    expect(done).toContain("conformance --rest");
    // Without --intent the CLI checks the sample's sales.quarterly_summary, which a new app does not serve.
    expect(done).toContain("--intent");
  });
});

describe("the RULES block is identical in every prompt (each prompt stays self-contained, so it is copied, not shared)", () => {
  const rules = PROMPTS.map(({ prompt }) => section(readFileSync(join(SITE_DIR, prompt), "utf8"), "RULES"));

  it("exists, and every prompt carries the same one", () => {
    expect(rules[0]).not.toBeNull();
    for (const r of rules) expect(r).toBe(rules[0]);
  });

  it("covers auth, the capability secret and the no-real-LLM rule", () => {
    expect(rules[0]).toContain("ANONYMOUS");
    expect(rules[0]).toContain("KOHAKU_CAPABILITY_SECRET");
    expect(rules[0]).toContain("FakeLlm");
  });
});

/** Every `.ts` / `.tsx` (kind "ts") or `.py` (kind "py") file under `dir`. */
function sourceFiles(dir: string, kind: "ts" | "py"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full, kind));
    else if ((kind === "ts" ? /\.tsx?$/ : /\.py$/).test(entry.name)) out.push(full);
  }
  return out;
}

/** The concatenated source of every file of `kind` under `roots`. */
function corpusOf(roots: string[], kind: "ts" | "py"): string {
  return roots
    .filter((r) => existsSync(r))
    .flatMap((r) => sourceFiles(r, kind))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
}

interface WorkspacePackage {
  name: string;
  private?: boolean;
  exports?: Record<string, unknown>;
}

/** Names that look like code but are product / prose words, or illustrative placeholders. */
const NOT_API_NAMES = new Set(["FastAPI", "sales_summary"]);

describe("agent prompts only name things that exist in this repository", () => {
  // A TypeScript prompt may only name TypeScript things, a Python prompt only Python things: matching a Python
  // prompt's identifiers against the TS sources (or the reverse) would pass an API that exists in the wrong port.
  const corpus = {
    ts: corpusOf(
      [
        ...readdirSync(join(REPO_ROOT, "packages")).map((p) => join(REPO_ROOT, "packages", p, "src")),
        join(REPO_ROOT, "cli/src"),
      ],
      "ts",
    ),
    py: corpusOf([join(REPO_ROOT, "python/kohaku/src"), join(REPO_ROOT, "python/examples")], "py"),
  };

  const workspacePackages = new Map<string, WorkspacePackage>();
  for (const dir of ["packages", "cli", "spec"]) {
    const base = join(REPO_ROOT, dir);
    const manifests =
      dir === "packages"
        ? readdirSync(base).map((p) => join(base, p, "package.json"))
        : [join(base, "package.json")];
    for (const m of manifests) {
      if (!existsSync(m)) continue;
      const pkg = JSON.parse(readFileSync(m, "utf8")) as WorkspacePackage;
      workspacePackages.set(pkg.name, pkg);
    }
  }

  describe.each(PROMPTS)("$prompt", ({ prompt, lang }) => {
    const source = readFileSync(join(SITE_DIR, prompt), "utf8");

    it("every @kohaku-ui/* package is a published workspace package", () => {
      const named = [...new Set([...source.matchAll(/@kohaku-ui\/[a-z0-9-]+/g)].map((m) => m[0]))];
      const bad = named.filter((n) => {
        const pkg = workspacePackages.get(n);
        return pkg == null || pkg.private === true;
      });
      expect(bad).toEqual([]);
    });

    it("every @kohaku-ui/<pkg>/<subpath> is an entry in that package's exports", () => {
      const subpaths = [...source.matchAll(/(@kohaku-ui\/[a-z0-9-]+)\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)/g)];
      const bad = subpaths
        .filter(([, name, sub]) => {
          const exportsMap = workspacePackages.get(name ?? "")?.exports ?? {};
          return !(`./${sub}` in exportsMap);
        })
        .map(([whole]) => whole);
      expect(bad).toEqual([]);
    });

    it("every CamelCase / camelCase / snake_case identifier is defined in this prompt's own language", () => {
      const names = new Set(
        source.match(/\b(?:[A-Z][a-z0-9]+){2,}\b|\b[a-z]+(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b/g) ??
          [],
      );
      const missing = [...names].filter(
        (n) => !NOT_API_NAMES.has(n) && !new RegExp(`\\b${n}\\b`).test(corpus[lang]),
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
