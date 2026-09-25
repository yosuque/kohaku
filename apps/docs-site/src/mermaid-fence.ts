import type { MarkdownRenderer } from "vitepress";

/**
 * Renders ```mermaid fences (used by docs/design.md; GitHub renders them natively) as a <Mermaid> component
 * instead of a plain code block. The component itself is registered by .vitepress/theme/index.ts.
 */
export function mermaidFence(md: MarkdownRenderer): void {
  const fence = md.renderer.rules.fence;
  if (fence == null) throw new Error("markdown-it fence rule is missing");
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token != null && token.info.trim() === "mermaid") {
      return `<Mermaid code="${md.utils.escapeHtml(token.content)}" />\n`;
    }
    return fence(tokens, idx, options, env, self);
  };
}
