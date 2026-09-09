import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { type ImplProps, RendererProvider, SpecView } from "../src/index.js";

// Render-hygiene characterization: a NodeView without visibleWhen (and without data.bind) must
// not re-render when an unrelated $state key changes. A NodeView that instead subscribed to the
// whole SpecStateProvider `values` object via useSpecState() would re-render the entire tree
// regardless of what an individual node actually depended on.

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

function toggleSpec(): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    state: { toggle: false },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["btn", "probe"] },
      { id: "btn", type: "action.button", props: { label: "Toggle" } },
      { id: "probe", type: "test.probe", props: {} },
    ],
    events: [{ on: "btn.press", emit: "state.set", payload: { key: "toggle", value: true } }],
    provenance: PROVENANCE,
  });
}

describe("render hygiene: a node with no visibleWhen and no data.bind is unaffected by a $state change", () => {
  it("clicking a button that fires state.set does not re-render a sibling probe node", () => {
    let probeRenders = 0;
    function Probe({ node }: ImplProps): ReactNode {
      probeRenders++;
      return <div data-kohaku={node.id}>probe</div>;
    }
    const impls = createCoreRegistry().register("test.probe", "1.0.0", Probe);

    render(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView spec={toggleSpec()} />
      </RendererProvider>,
    );
    expect(probeRenders).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
    // state.set fired, but the probe node has nothing that depends on $state (no visibleWhen, no
    // data.bind) — it must not re-render.
    expect(probeRenders).toBe(1);
  });
});
