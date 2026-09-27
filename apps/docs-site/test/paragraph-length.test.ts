import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Maximum length, in characters of the raw Markdown source (code/tables/lists excluded, see
 * extractParagraphs), a single prose paragraph may run to. Applies equally to English and Japanese: both
 * are counted in characters, not words, so the same number is comparable across the two — see brief u6.
 */
const MAX_PARAGRAPH_LENGTH = 1200;

export interface Paragraph {
  /** 1-based line the paragraph starts on (its first non-blank source line). */
  startLine: number;
  /** The paragraph's lines joined with a single space; fenced code / tables / lists / headings excluded. */
  text: string;
}

/**
 * Extracts prose paragraphs from Markdown for a length check, not for rendering: fenced (``` / ~~~) code
 * blocks, table rows (a line starting with `|`), list items (`-` / `*` / `+` / `1.`), horizontal rules and
 * headings are all excluded, since none of them is prose a reader reads as one continuous paragraph. A
 * blockquote's leading `>` marker is stripped so its own prose is still checked like any other paragraph —
 * this repository's user-guide.md carries long blockquote "notes" that are exactly the kind of paragraph
 * this check exists to catch.
 */
export function extractParagraphs(markdown: string): Paragraph[] {
  const lines = markdown.split("\n");
  let inFence = false;
  const paragraphs: Paragraph[] = [];
  let current: string[] = [];
  let startLine = 0;

  const flush = () => {
    if (current.length > 0) {
      paragraphs.push({ startLine, text: current.join(" ") });
      current = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;
    const line = raw.replace(/^\s*>\s?/, "");
    const trimmed = line.trim();
    const isHeading = /^#{1,6}\s/.test(trimmed);
    const isTableRow = trimmed.startsWith("|");
    const isListItem = /^([-*+]|\d+[.)])\s/.test(trimmed);
    const isRule = /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed);
    if (trimmed === "" || isHeading || isTableRow || isListItem || isRule) {
      flush();
      continue;
    }
    if (current.length === 0) startLine = i + 1;
    current.push(trimmed);
  }
  flush();
  return paragraphs;
}

/** The subset of `paragraphs` longer than MAX_PARAGRAPH_LENGTH characters. */
export function findLongParagraphs(paragraphs: readonly Paragraph[]): Paragraph[] {
  return paragraphs.filter((p) => p.text.length > MAX_PARAGRAPH_LENGTH);
}

/**
 * The pages this check covers: "Why kohaku", the user guide, and the three adoption paths, in both
 * languages — the newcomer-facing, longest-form prose in the docs corpus (brief u6). Every other mirrored
 * page is out of scope; adding one here is a deliberate per-page choice, not a default this test expands
 * on its own.
 */
const PAGES = [
  "docs/why-kohaku.md",
  "docs/why-kohaku.ja.md",
  "docs/user-guide.md",
  "docs/user-guide.ja.md",
  "docs/paths/mcp-apps.md",
  "docs/paths/mcp-apps.ja.md",
  "docs/paths/react-dashboard.md",
  "docs/paths/react-dashboard.ja.md",
  "docs/paths/full-stack.md",
  "docs/paths/full-stack.ja.md",
];

describe.each(PAGES)("%s", (page) => {
  it("has no prose paragraph over 1200 characters (split it by point of argument instead)", () => {
    const markdown = readFileSync(join(REPO_ROOT, page), "utf8");
    const long = findLongParagraphs(extractParagraphs(markdown));
    const detail = long.map((p) => `line ${p.startLine}: ${p.text.length} chars`);
    expect(detail).toEqual([]);
  });
});

describe("extractParagraphs", () => {
  it("stops a paragraph at a blank line", () => {
    const paragraphs = extractParagraphs("First paragraph.\n\nSecond paragraph.");
    expect(paragraphs.map((p) => p.text)).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("excludes a fenced code block", () => {
    const md = "Prose before.\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nProse after.";
    expect(extractParagraphs(md).map((p) => p.text)).toEqual(["Prose before.", "Prose after."]);
  });

  it("excludes table rows", () => {
    const md = "Intro.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro.";
    expect(extractParagraphs(md).map((p) => p.text)).toEqual(["Intro.", "Outro."]);
  });

  it("excludes list items", () => {
    const md = "Intro.\n\n- one\n- two\n\nOutro.";
    expect(extractParagraphs(md).map((p) => p.text)).toEqual(["Intro.", "Outro."]);
  });

  it("excludes a heading", () => {
    const md = "## Heading\n\nBody text.";
    expect(extractParagraphs(md).map((p) => p.text)).toEqual(["Body text."]);
  });

  it("excludes a horizontal rule", () => {
    const md = "Above.\n\n---\n\nBelow.";
    expect(extractParagraphs(md).map((p) => p.text)).toEqual(["Above.", "Below."]);
  });

  it("strips a blockquote marker so its prose is still checked as a paragraph", () => {
    const md = "> First line.\n> Second line.";
    expect(extractParagraphs(md).map((p) => p.text)).toEqual(["First line. Second line."]);
  });

  it("reports the 1-based start line of a multi-line paragraph", () => {
    const md = "Intro line\n\nline one\nline two\nline three";
    const paragraphs = extractParagraphs(md);
    expect(paragraphs[1]).toEqual({ startLine: 3, text: "line one line two line three" });
  });
});

describe("findLongParagraphs", () => {
  it("flags a paragraph over the limit and passes one at or under it", () => {
    const long: Paragraph = { startLine: 1, text: "x".repeat(1201) };
    const short: Paragraph = { startLine: 2, text: "x".repeat(1200) };
    expect(findLongParagraphs([long, short])).toEqual([long]);
  });
});
