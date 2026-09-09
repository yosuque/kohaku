import { type MarkdownBlock, type MarkdownInline, parseMarkdownBlocks } from "@kohaku-ui/renderer-core";
import { createElement, type ReactNode } from "react";
import { type ImplProps, useToken } from "../context.js";

export function TextHeading({ node }: ImplProps): ReactNode {
  const level = Math.min(6, Math.max(1, (node.props["level"] as number) ?? 2));
  const color = String(useToken("color.text"));
  return createElement(
    `h${level}`,
    {
      "data-kohaku": node.id,
      style: { margin: 0, color, fontWeight: 650, lineHeight: 1.3 },
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
  const color = String(useToken("color.text"));
  const muted = String(useToken("color.muted"));
  const surface = String(useToken("color.surface"));
  return (
    <div data-kohaku={node.id} style={{ color, fontSize: 14, lineHeight: 1.7 }}>
      {parseMarkdownBlocks(markdown).map((block, key) => renderBlock(block, key, muted, surface))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, key: number, muted: string, surface: string): ReactNode {
  if (block.type === "code") {
    return (
      <pre
        key={key}
        style={{
          background: surface,
          borderRadius: 6,
          padding: "10px 12px",
          overflowX: "auto",
          fontSize: 12.5,
        }}
      >
        <code>{block.code}</code>
      </pre>
    );
  }
  if (block.type === "heading") {
    // block.level is the already-resolved HTML heading level (min(level + 2, 6)).
    return createElement(
      `h${block.level}`,
      { key, style: { margin: "8px 0 4px", fontWeight: 650 } },
      renderInline(block.inline, surface),
    );
  }
  if (block.type === "list") {
    return (
      <ul key={key} style={{ margin: "4px 0", paddingLeft: 20 }}>
        {block.items.map((item, j) => (
          // The markdown AST is re-parsed from a plain string on every render (no persisted item
          // identity to key by), and list items are stateless leaf content (no input/interactive
          // state that an index key could cross-wire), so an index key is safe here.
          // biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf content re-derived each render; see comment above.
          <li key={j}>{renderInline(item, surface)}</li>
        ))}
      </ul>
    );
  }
  return (
    <p key={key} style={{ margin: "4px 0", color: block.muted ? muted : undefined }}>
      {renderInline(block.inline, surface)}
    </p>
  );
}

function renderInline(inline: MarkdownInline[], surface: string): ReactNode[] {
  return inline.map((part, i) => {
    if (part.type === "code") {
      // Same reasoning as the list-item key above: re-parsed from a plain string each render,
      // stateless leaf content -- an index key is safe.
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: stateless leaf content re-derived each render.
        <code key={i} style={{ background: surface, borderRadius: 4, padding: "1px 5px", fontSize: 12.5 }}>
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
