import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView } from "../src/index.js";

const PROVENANCE = { tier: "L1", composedBy: "test", cache: "hit" } as const;
const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;

// A spec placing a component that always throws during rendering next to a healthy sibling (text.heading).
function bombSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["bomb1", "sib"] },
      { id: "bomb1", type: "bomb", props: {} },
      { id: "sib", type: "text.heading", props: { level: 2, text: "Alive" } },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

describe("per-node error boundary", () => {
  it("even if a part throws, siblings still render and the fallback and onNodeError appear", () => {
    // React logs to console.error even when an error boundary catches, so suppress the warning during the test.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const errors: { componentId: string; componentType: string }[] = [];
    const impls = createCoreRegistry().register("bomb", "1.0.0", () => {
      throw new Error("boom");
    });

    render(
      <RendererProvider
        value={{
          impls,
          theme: {},
          onNodeError: (a) => errors.push({ componentId: a.componentId, componentType: a.componentType }),
        }}
      >
        <SpecView spec={bombSpec()} />
      </RendererProvider>,
    );

    // (a) The sibling node survives and renders
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Alive");
    // (b) The bomb node is replaced with the fallback message (nodeRenderFailed's default)
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("bomb");
    expect(note.textContent).toContain("bomb1");
    // (c) onNodeError fires exactly once with componentId
    expect(errors).toEqual([{ componentId: "bomb1", componentType: "bomb" }]);

    spy.mockRestore();
  });
});
