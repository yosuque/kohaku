import { type MarkdownInline, parseMarkdownBlocks } from "@kohaku-ui/renderer-core";
import { el, text } from "../dom.js";
import type { PartBuilder } from "../types.js";
import { tokenStr } from "./kit.js";

/** text.heading — a heading (same markup as renderer-react's TextHeading). */
export const textHeading: PartBuilder = (rt, parent, node) => {
  const level = Math.min(6, Math.max(1, (node.props["level"] as number) ?? 2));
  const color = tokenStr(rt, "color.text");
  const heading = el(
    `h${level}`,
    { "data-kohaku": node.id },
    { margin: 0, color, fontWeight: 650, lineHeight: 1.3 },
  );
  heading.appendChild(text(String(node.props["text"] ?? "")));
  parent.appendChild(heading);
  return () => heading.remove();
};

/**
 * presentMarkdown — zero-dependency rendering of a Markdown subset (same as renderer-react's PresentMarkdown).
 * The AST is shared via renderer-core's parseMarkdownBlocks / parseMarkdownInline (empty text segments are also preserved).
 */
export const presentMarkdown: PartBuilder = (rt, parent, node) => {
  const markdown = String(node.props["markdown"] ?? "");
  const color = tokenStr(rt, "color.text");
  const muted = tokenStr(rt, "color.muted");
  const surface = tokenStr(rt, "color.surface");
  const container = el("div", { "data-kohaku": node.id }, { color, fontSize: 14, lineHeight: 1.7 });

  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.type === "code") {
      const pre = el(
        "pre",
        {},
        { background: surface, borderRadius: 6, padding: "10px 12px", overflowX: "auto", fontSize: 12.5 },
      );
      const code = el("code");
      code.appendChild(text(block.code));
      pre.appendChild(code);
      container.appendChild(pre);
    } else if (block.type === "heading") {
      const h = el(`h${block.level}`, {}, { margin: "8px 0 4px", fontWeight: 650 });
      appendInline(h, block.inline, surface);
      container.appendChild(h);
    } else if (block.type === "list") {
      const ul = el("ul", {}, { margin: "4px 0", paddingLeft: 20 });
      for (const item of block.items) {
        const li = el("li");
        appendInline(li, item, surface);
        ul.appendChild(li);
      }
      container.appendChild(ul);
    } else {
      const p = el("p", {}, { margin: "4px 0", ...(block.muted ? { color: muted } : {}) });
      appendInline(p, block.inline, surface);
      container.appendChild(p);
    }
  }

  parent.appendChild(container);
  return () => container.remove();
};

/** Flows the inline AST into an element (emits a node even for empty text to keep textContent matching). */
function appendInline(host: HTMLElement, inline: MarkdownInline[], surface: string): void {
  for (const part of inline) {
    if (part.type === "code") {
      const code = el(
        "code",
        {},
        { background: surface, borderRadius: 4, padding: "1px 5px", fontSize: 12.5 },
      );
      code.appendChild(text(part.text));
      host.appendChild(code);
    } else if (part.type === "strong") {
      const strong = el("strong");
      strong.appendChild(text(part.text));
      host.appendChild(strong);
    } else {
      host.appendChild(text(part.text));
    }
  }
}
