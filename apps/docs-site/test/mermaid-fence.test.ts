import type { MarkdownRenderer } from "vitepress";
import { describe, expect, it, vi } from "vitest";
import { mermaidFence } from "../src/mermaid-fence.js";

type FenceFn = (tokens: unknown[], idx: number, options: unknown, env: unknown, self: unknown) => string;

/**
 * A minimal stub of the markdown-it renderer object mermaidFence mutates. The real renderer drags
 * VitePress's whole markdown pipeline into what should be a pure unit test, so we hand-build just the
 * two surfaces (`renderer.rules.fence`, `utils.escapeHtml`) the function under test touches.
 */
function makeStubMd(fence: FenceFn | null | undefined) {
  return {
    renderer: { rules: { fence } },
    utils: { escapeHtml: (s: string) => s.replace(/</g, "&lt;").replace(/>/g, "&gt;") },
  };
}

describe("mermaidFence", () => {
  it("renders a mermaid fence as a <Mermaid> component with HTML-escaped content", () => {
    const original = vi.fn(() => "<pre>original</pre>");
    const stub = makeStubMd(original);
    // Cast: satisfies the MarkdownRenderer parameter shape without pulling in markdown-it's real types.
    mermaidFence(stub as unknown as MarkdownRenderer);

    const token = { info: "mermaid", content: "graph TD; A-->B;" };
    // Non-null: this scenario always passes a defined fence rule (the null/undefined case is its own test below).
    const result = stub.renderer.rules.fence!([token], 0, {}, {}, {});

    // The literal "-->" becomes "--&gt;", proving escapeHtml actually ran (not just passed through).
    expect(result).toBe('<Mermaid code="graph TD; A--&gt;B;" />\n');
    expect(original).not.toHaveBeenCalled();
  });

  it("delegates a non-mermaid fence to the original rule with the arguments unchanged", () => {
    const original = vi.fn(() => "<pre>original</pre>");
    const stub = makeStubMd(original);
    mermaidFence(stub as unknown as MarkdownRenderer);

    const tokens = [{ info: "ts", content: "const x = 1;" }];
    const result = stub.renderer.rules.fence!(tokens, 0, "opts", "env", "self");

    expect(result).toBe("<pre>original</pre>");
    expect(original).toHaveBeenCalledWith(tokens, 0, "opts", "env", "self");
  });

  it("throws when the fence rule is missing", () => {
    expect(() => mermaidFence(makeStubMd(undefined) as unknown as MarkdownRenderer)).toThrow();
    expect(() => mermaidFence(makeStubMd(null) as unknown as MarkdownRenderer)).toThrow();
  });
});
