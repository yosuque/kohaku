import {
  type MarkdownBlock,
  type MarkdownInline,
  parseMarkdownBlocks,
  type SizingTokens,
  textBodyStyle,
  textCodeStyle,
  textHeadingStyle,
  textListStyle,
  textPreStyle,
  textSubheadingStyle,
} from "@kohaku-ui/renderer-core";
import { createElement, type ReactNode } from "react";
import { type ImplProps, useSizing, useToken } from "../context.js";

export function TextHeading({ node }: ImplProps): ReactNode {
  const level = Math.min(6, Math.max(1, (node.props["level"] as number) ?? 2));
  const color = String(useToken("color.text"));
  return createElement(
    `h${level}`,
    {
      "data-kohaku": node.id,
      style: textHeadingStyle(color),
    },
    String(node.props["text"] ?? ""),
  );
}

/**
 * Zero-dependency rendering of a Markdown subset (headings / bullet lists / code blocks /
 * inline code / emphasis / paragraphs). Mainly used for fallback display and notes.
 * Parsing (turning into an AST) has the framework-free renderer-core (parseMarkdownBlocks) as the single source of truth,
 * and this only holds the mapping AST → React elements (renderer-wc maps the same AST to plain DOM).
 */
export function PresentMarkdown({ node }: ImplProps): ReactNode {
  const markdown = String(node.props["markdown"] ?? "");
  const sizing = useSizing();
  const color = String(useToken("color.text"));
  const muted = String(useToken("color.muted"));
  const surface = String(useToken("color.surface"));
  return (
    <div data-kohaku={node.id} style={textBodyStyle(color, sizing)}>
      {parseMarkdownBlocks(markdown).map((block, key) => renderBlock(block, key, muted, surface, sizing))}
    </div>
  );
}

function renderBlock(
  block: MarkdownBlock,
  key: number,
  muted: string,
  surface: string,
  sizing: SizingTokens,
): ReactNode {
  if (block.type === "code") {
    return (
      <pre key={key} style={textPreStyle(surface, sizing)}>
        <code>{block.code}</code>
      </pre>
    );
  }
  if (block.type === "heading") {
    // block.level is the already-resolved HTML heading level (min(level + 2, 6)).
    return createElement(
      `h${block.level}`,
      { key, style: textSubheadingStyle(sizing) },
      renderInline(block.inline, surface, sizing),
    );
  }
  if (block.type === "list") {
    return (
      <ul key={key} style={textListStyle(sizing)}>
        {block.items.map((item, j) => (
          // The markdown AST is re-parsed from a plain string on every render (no persisted item
          // identity to key by), and list items are stateless leaf content (no input/interactive
          // state that an index key could cross-wire), so an index key is safe here.
          // biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf content re-derived each render; see comment above.
          <li key={j}>{renderInline(item, surface, sizing)}</li>
        ))}
      </ul>
    );
  }
  return (
    <p key={key} style={{ margin: "4px 0", color: block.muted ? muted : undefined }}>
      {renderInline(block.inline, surface, sizing)}
    </p>
  );
}

function renderInline(inline: MarkdownInline[], surface: string, sizing: SizingTokens): ReactNode[] {
  return inline.map((part, i) => {
    if (part.type === "code") {
      // Same reasoning as the list-item key above: re-parsed from a plain string each render,
      // stateless leaf content -- an index key is safe.
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf content re-derived each render.
        <code key={i} style={textCodeStyle(surface, sizing)}>
          {part.text}
        </code>
      );
    }
    if (part.type === "strong") {
      // biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf content re-derived each render (see above).
      return <strong key={i}>{part.text}</strong>;
    }
    return part.text;
  });
}
