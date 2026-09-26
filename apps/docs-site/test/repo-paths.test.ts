import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMirrorSources } from "../src/mirror.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

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
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const candidate = stripLineAndAnchor(m[1] ?? "");
      if (isCheckable(candidate)) refs.push({ file, line: lineNumber, path: candidate });
    }
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
});
