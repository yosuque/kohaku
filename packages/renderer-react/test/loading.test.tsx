import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "test", cache: "miss" } as const;

/** Equivalent to composeStream's skeleton (root + ui.loading). */
function skeletonSpec(label?: string): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["loading1"] },
      {
        id: "loading1",
        type: "ui.loading",
        props: label != null ? { label } : {},
      },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

function renderSpec(spec: UISpec) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), theme: {} }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("ui.loading renderer", () => {
  it("renders with role='status' + aria-busy='true'", () => {
    renderSpec(skeletonSpec());
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
  });

  it("displays the label prop", () => {
    renderSpec(skeletonSpec("Generating…"));
    expect(screen.getByRole("status").textContent).toContain("Generating…");
  });
});
