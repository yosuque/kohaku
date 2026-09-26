import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMirrorSources } from "../src/mirror.js";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(SITE_DIR, "../..");

/**
 * One repository-path-shaped reference found in a Markdown file's prose (an inline code span or a
 * Markdown link href), resolved to a repository-relative posix path.
 */
export interface PathReference {
  /** Repository-relative source file the reference was found in (posix), e.g. "docs/user-guide.md". */
  file: string;
  /** 1-based line number within that file. */
  line: number;
  /** The reference resolved to a repository-relative posix path (":line" / "#anchor" already stripped). */
  path: string;
}

/** Only a reference under one of these roots is worth checking; anything else (npm package names, prose
 * that merely contains a slash, etc.) is left alone. */
const TARGET_PREFIX = /^(apps|packages|cli|spec|python|scripts|docs)\//;

/** Build output / runtime state: gitignored and never part of the source tree, so never checked. */
const EXCLUDED_SEGMENT = /(?:^|\/)(?:dist|\.data|\.generated|node_modules)(?:\/|$)/;

/** A placeholder (`<...>`, an ellipsis `…`) or a glob (`*`) — not a concrete path to resolve. */
const PLACEHOLDER = /[<>*…]/;

/** Strips a trailing `#anchor` and then a trailing `:123` / `:123-456` line reference from a written path. */
function stripLineAndAnchor(raw: string): string {
  const hashIndex = raw.indexOf("#");
  const withoutAnchor = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  return withoutAnchor.replace(/:\d+(?:-\d+)?$/, "");
}

/**
 * Blanks out fenced (``` / ~~~) code blocks so only prose inline code and links are scanned — a fenced
 * block's own contents (e.g. a terminal transcript naming an unrelated path) are not checked. Line numbers
 * are preserved (a blanked line stays, just empty). Mirrors the fence-tracking in ../src/mirror.ts's
 * rewriteLinks and in github-slug.test.ts's pageAnchors / extractAnchorLinks.
 */
function withoutFencedCode(markdown: string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return "";
      }
      return inFence ? "" : line;
    })
    .join("\n");
}

function isCheckable(path: string): boolean {
  return TARGET_PREFIX.test(path) && !PLACEHOLDER.test(path) && !EXCLUDED_SEGMENT.test(path);
}

/** A link this test does not resolve at all: a scheme (https:, mailto:, ...) or a bare in-page anchor. */
function isOutOfScope(href: string): boolean {
  return href === "" || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * Every repository-path-shaped backtick-quoted span in `text` (":line" / "#anchor" already stripped),
 * filtered to checkable candidates. Shared by extractPathReferences (a Markdown inline-code span) and
 * extractTsCommentPathReferences (a TypeScript `//` or `/* *\/` comment) — both quote a repository path
 * inside backticks the same way, and neither resolves it against the file's own directory.
 */
function checkablePathsIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const candidate = stripLineAndAnchor(m[1] ?? "");
    if (isCheckable(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Every repository-path-shaped inline-code span or Markdown link href in `markdown`'s prose, resolved to a
 * repository-relative posix path (a link's relative href is resolved against `file`'s own directory; an
 * inline-code path is taken as already repository-relative, matching how this repository always writes
 * one). Exported separately from findMissingPaths so extraction and existence-checking are independently
 * unit-testable (see the describe blocks below).
 */
export function extractPathReferences(markdown: string, file: string): PathReference[] {
  const prose = withoutFencedCode(markdown);
  const refs: PathReference[] = [];
  prose.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;
    for (const path of checkablePathsIn(line)) refs.push({ file, line: lineNumber, path });
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = stripLineAndAnchor(m[1] ?? "");
      if (isOutOfScope(href)) continue;
      const resolved = href.startsWith("/")
        ? href.slice(1)
        : posix.normalize(posix.join(posix.dirname(file), href));
      if (isCheckable(resolved)) refs.push({ file, line: lineNumber, path: resolved });
    }
  });
  return refs;
}

/** The subset of `refs` whose `path` does not exist under `repoRoot`, as a file or a directory. */
export function findMissingPaths(refs: readonly PathReference[], repoRoot: string): PathReference[] {
  return refs.filter((ref) => !existsSync(join(repoRoot, ref.path)));
}

/**
 * Every Markdown file this check covers: the docs-site mirror corpus (docs/**, spec/SPEC*.md,
 * spec/examples, python/README*.md — see mirror.ts's MIRROR_ROOTS) plus the repository root's README.md
 * and AGENTS.md, which are read by contributors and AI agents but are not mirrored into the generated site.
 */
function corpusFiles(): string[] {
  const mirroredMarkdown = listMirrorSources(REPO_ROOT).filter((source) => source.endsWith(".md"));
  return [...mirroredMarkdown, "README.md", "AGENTS.md"];
}

/**
 * The text of every `//` line comment and `/* *\/` block comment in a TypeScript/TSX source, one entry per
 * source line (a line with no comment on it gets ""). Strings and template literals are tracked (with
 * `\`-escape handling) so an occurrence like "http://" inside a string is never mistaken for a comment —
 * e.g. `const BASE_URL = "http://localhost:8787/api/kohaku";` in react-dashboard-host.tsx has no comment on
 * it at all. This is a minimal hand-rolled scanner, not a full parser: it only has to find comment
 * boundaries in the small, hand-written, conventionally formatted files under apps/docs-site/snippets/**.
 */
function commentTextByLine(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = lines.map(() => "");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let j = 0;
    let quote: string | null = null;
    while (j < line.length) {
      if (inBlockComment) {
        const end = line.indexOf("*/", j);
        if (end === -1) {
          out[i] += line.slice(j);
          break;
        }
        out[i] += line.slice(j, end);
        inBlockComment = false;
        j = end + 2;
        continue;
      }
      const ch = line[j];
      if (quote != null) {
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === quote) quote = null;
        j++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        j++;
        continue;
      }
      if (ch === "/" && line[j + 1] === "/") {
        out[i] += line.slice(j + 2);
        break;
      }
      if (ch === "/" && line[j + 1] === "*") {
        const end = line.indexOf("*/", j + 2);
        if (end === -1) {
          inBlockComment = true;
          out[i] += line.slice(j + 2);
          break;
        }
        out[i] += line.slice(j + 2, end);
        j = end + 2;
        continue;
      }
      j++;
    }
  }
  return out;
}

/**
 * Every repository-path-shaped backtick-quoted path written inside a `//` or `/* *\/` comment of a
 * TypeScript/TSX source file, e.g. the stale `apps/sample-api/src/ports/authz-port.ts` this test's own
 * "deliberately broken" case below is modeled on (a real defect once present in
 * apps/docs-site/snippets/kohaku/ports.ts's JSDoc). Exported separately from findMissingPaths for the same
 * reason as extractPathReferences.
 */
export function extractTsCommentPathReferences(source: string, file: string): PathReference[] {
  const refs: PathReference[] = [];
  commentTextByLine(source).forEach((commentText, index) => {
    for (const path of checkablePathsIn(commentText)) refs.push({ file, line: index + 1, path });
  });
  return refs;
}

/** Every `.ts` / `.tsx` file under `dir`, recursively, as absolute paths (sorted, for stable test order). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listTsFiles(abs));
    else if (/\.tsx?$/.test(name)) out.push(abs);
  }
  return out;
}

/** Every adoption-path snippet .ts/.tsx file (apps/docs-site/snippets/**), as repository-relative posix paths. */
function snippetTsFiles(): string[] {
  return listTsFiles(join(SITE_DIR, "snippets")).map((abs) => relative(REPO_ROOT, abs).split(sep).join("/"));
}

describe("every apps|packages|cli|spec|python|scripts|docs path written in the docs corpus exists", () => {
  for (const file of corpusFiles()) {
    it(file, () => {
      const markdown = readFileSync(join(REPO_ROOT, file), "utf8");
      const missing = findMissingPaths(extractPathReferences(markdown, file), REPO_ROOT);
      const detail = missing.map((ref) => `${ref.file}:${ref.line}: \`${ref.path}\` does not exist`);
      expect(detail).toEqual([]);
    });
  }
});

describe("every apps|packages|cli|spec|python|scripts|docs path written in a docs-site snippet .ts/.tsx comment exists", () => {
  for (const file of snippetTsFiles()) {
    it(file, () => {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      const missing = findMissingPaths(extractTsCommentPathReferences(source, file), REPO_ROOT);
      const detail = missing.map((ref) => `${ref.file}:${ref.line}: \`${ref.path}\` does not exist`);
      expect(detail).toEqual([]);
    });
  }
});

describe("extractPathReferences", () => {
  it("finds a repository-relative inline-code path", () => {
    const refs = extractPathReferences(
      "See `packages/spec-core/src/ports.ts` for the contract.",
      "docs/x.md",
    );
    expect(refs).toEqual([{ file: "docs/x.md", line: 1, path: "packages/spec-core/src/ports.ts" }]);
  });

  it("strips a trailing :line / :start-end from an inline-code path", () => {
    const refs = extractPathReferences("`cli/src/commands.ts:129-133` writes the scaffold.", "docs/x.md");
    expect(refs.map((r) => r.path)).toEqual(["cli/src/commands.ts"]);
  });

  it("resolves a relative link's href against the file's own directory", () => {
    const refs = extractPathReferences("[ports](../../packages/spec-core/src/ports.ts)", "docs/paths/x.md");
    expect(refs.map((r) => r.path)).toEqual(["packages/spec-core/src/ports.ts"]);
  });

  it("strips a trailing #anchor from a link", () => {
    const refs = extractPathReferences("[x](../design.md#some-heading)", "docs/paths/x.md");
    expect(refs.map((r) => r.path)).toEqual(["docs/design.md"]);
  });

  it("reports the correct 1-based line number for a reference past the first line", () => {
    const refs = extractPathReferences("line one\nline two\n`docs/design.md` on line three", "docs/x.md");
    expect(refs).toEqual([{ file: "docs/x.md", line: 3, path: "docs/design.md" }]);
  });

  it("ignores a path inside a fenced code block", () => {
    const md = '```ts\nimport x from "packages/does-not-exist/x.ts";\n```';
    expect(extractPathReferences(md, "docs/x.md")).toEqual([]);
  });

  it("ignores a placeholder path", () => {
    expect(extractPathReferences("`apps/<your-app>/index.ts`", "docs/x.md")).toEqual([]);
  });

  it("ignores a glob", () => {
    expect(extractPathReferences("`packages/*/src/index.ts`", "docs/x.md")).toEqual([]);
  });

  it("ignores build output and runtime-state directories", () => {
    const md = "`packages/spec-core/dist/index.js`, `apps/sample-api/.data/x.json` and `docs/.generated/y`";
    expect(extractPathReferences(md, "docs/x.md")).toEqual([]);
  });

  it("ignores node_modules", () => {
    expect(extractPathReferences("`node_modules/@kohaku-ui/cli/dist/index.js`", "docs/x.md")).toEqual([]);
  });

  it("ignores a scheme URL and a bare in-page anchor link", () => {
    const md = "[x](https://example.com/apps/foo) and [y](#apps-section)";
    expect(extractPathReferences(md, "docs/x.md")).toEqual([]);
  });

  it("ignores a path that does not start under a tracked root", () => {
    expect(extractPathReferences("`.github/workflows/ci.yml` and `node:fs`", "docs/x.md")).toEqual([]);
  });
});

describe("extractTsCommentPathReferences", () => {
  it("finds a repository-relative path quoted inside a // line comment", () => {
    const source = 'import { x } from "./x.js"; // see `packages/spec-core/src/ports.ts`\n';
    const refs = extractTsCommentPathReferences(source, "apps/docs-site/snippets/kohaku/ports.ts");
    expect(refs).toEqual([
      { file: "apps/docs-site/snippets/kohaku/ports.ts", line: 1, path: "packages/spec-core/src/ports.ts" },
    ]);
  });

  it("finds a repository-relative path quoted inside a multi-line /* */ block comment", () => {
    const source = ["/**", " * Copy `packages/spec-core/src/ports.ts` instead.", " */", "export {};"].join(
      "\n",
    );
    const refs = extractTsCommentPathReferences(source, "apps/docs-site/snippets/kohaku/ports.ts");
    expect(refs).toEqual([
      { file: "apps/docs-site/snippets/kohaku/ports.ts", line: 2, path: "packages/spec-core/src/ports.ts" },
    ]);
  });

  it("does not mistake // inside a string literal for the start of a comment", () => {
    const source = 'const BASE_URL = "http://localhost:8787/api/kohaku"; // real comment, no backtick path\n';
    expect(extractTsCommentPathReferences(source, "apps/docs-site/snippets/x.ts")).toEqual([]);
  });

  it("ignores a backtick-quoted path inside a plain code string, not a comment", () => {
    const source = 'const s = "`packages/does-not-exist/x.ts`"; // no path in the comment itself\n';
    expect(extractTsCommentPathReferences(source, "apps/docs-site/snippets/x.ts")).toEqual([]);
  });

  it("applies the same placeholder / build-output exclusions as Markdown extraction", () => {
    const source = "// `apps/<your-app>/x.ts` and `packages/spec-core/dist/index.js`\n";
    expect(extractTsCommentPathReferences(source, "apps/docs-site/snippets/x.ts")).toEqual([]);
  });
});

describe("findMissingPaths", () => {
  it("flags a path that does not exist and passes one that does", () => {
    const refs = [
      { file: "docs/x.md", line: 1, path: "docs/design.md" }, // exists
      { file: "docs/x.md", line: 2, path: "docs/does-not-exist.md" }, // missing
    ];
    expect(findMissingPaths(refs, REPO_ROOT).map((r) => r.path)).toEqual(["docs/does-not-exist.md"]);
  });

  it("treats an existing directory (no extension) as present", () => {
    const refs = [{ file: "spec/SPEC.md", line: 1, path: "packages/spec-core" }];
    expect(findMissingPaths(refs, REPO_ROOT)).toEqual([]);
  });
});

describe("extraction + existence together detect a deliberately broken reference", () => {
  it("flags a nonexistent path written in a fabricated Markdown snippet", () => {
    const markdown = "The port contract lives in `packages/this-package-does-not-exist/src/ports.ts`.";
    const refs = extractPathReferences(markdown, "docs/fake.md");
    const missing = findMissingPaths(refs, REPO_ROOT);
    expect(missing).toEqual([
      { file: "docs/fake.md", line: 1, path: "packages/this-package-does-not-exist/src/ports.ts" },
    ]);
  });

  it("flags a nonexistent path written in a fabricated TypeScript comment", () => {
    const source = "  // Copy `apps/sample-api/src/ports/authz-port.ts` instead.\n";
    const file = "apps/docs-site/snippets/kohaku/fake.ts";
    const refs = extractTsCommentPathReferences(source, file);
    const missing = findMissingPaths(refs, REPO_ROOT);
    expect(missing).toEqual([{ file, line: 1, path: "apps/sample-api/src/ports/authz-port.ts" }]);
  });
});
