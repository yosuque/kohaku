/**
 * A zero-dependency Markdown-subset parser (headings / bullet lists / code blocks
 * / inline code / emphasis / paragraphs). renderer-react used to generate JSX
 * directly, but here we return a framework-free AST and each renderer maps the AST
 * to markup. The parse rules match text.tsx's renderBlocks / renderInline 1:1.
 */

/** Inline elements (plain text / inline code / emphasis). */
export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string };

/**
 * Block elements. heading.level is the **already-resolved HTML heading level**
 * (`#`–`####` mapped to min(level + 2, 6)), so each renderer can just emit
 * h{level}. paragraph.muted is the flag that renders a quote line (starting with
 * `>`) in a muted color.
 */
export type MarkdownBlock =
  | { type: "code"; code: string }
  | { type: "heading"; level: number; inline: MarkdownInline[] }
  | { type: "list"; items: MarkdownInline[][] }
  | { type: "paragraph"; muted: boolean; inline: MarkdownInline[] };

/** Splits a Markdown string into a block AST (the same scanning rule as text.tsx renderBlocks). */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++;
      blocks.push({ type: "code", code: code.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading != null) {
      const level = heading[1]!.length;
      blocks.push({
        type: "heading",
        level: Math.min(level + 2, 6),
        inline: parseMarkdownInline(heading[2]!),
      });
      i++;
      continue;
    }

    if (line.startsWith("- ")) {
      const items: MarkdownInline[][] = [];
      while (i < lines.length && lines[i]!.startsWith("- ")) {
        items.push(parseMarkdownInline(lines[i++]!.slice(2)));
      }
      blocks.push({ type: "list", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    blocks.push({
      type: "paragraph",
      muted: line.startsWith(">"),
      inline: parseMarkdownInline(line.replace(/^>\s?/, "")),
    });
    i++;
  }
  return blocks;
}

/**
 * Splits inline notation (`code` and **bold**) (the same as text.tsx
 * renderInline). Due to how split works, empty-string segments can be inserted at
 * notation boundaries, but to match renderer-react's output byte-for-byte we do not
 * remove them and keep them as text nodes as-is.
 */
export function parseMarkdownInline(text: string): MarkdownInline[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part): MarkdownInline => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return { type: "code", text: part.slice(1, -1) };
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return { type: "strong", text: part.slice(2, -2) };
    }
    return { type: "text", text: part };
  });
}
