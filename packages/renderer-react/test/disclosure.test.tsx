import { parseSpec } from "@kohaku-ui/spec-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { createCoreRegistry } from "../src/core/index.js";
import { DEFAULT_MESSAGES, RendererProvider, SpecView } from "../src/index.js";

// The fixture's own provenance is tier L1 / cache "hit" -> disclosure level "ai-generated" (see
// spec/examples/quarterly-sales.spec.json).
const L1_SPEC = parseSpec(fixture);

const L0_FIXATED_SPEC = parseSpec({
  ...fixture,
  provenance: { tier: "L0", composedBy: "composer@0.1.0", cache: "fixated" },
});

const L0_NONE_SPEC = parseSpec({
  ...fixture,
  provenance: { tier: "L0", composedBy: "composer@0.1.0", cache: "miss" },
});

function renderSpec(spec: typeof L1_SPEC, disclosure?: "off" | "attributes" | "label") {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), theme: {} }}>
      <SpecView spec={spec} {...(disclosure != null ? { disclosure } : {})} />
    </RendererProvider>,
  );
}

describe("SpecView disclosure prop (design.md #66)", () => {
  it('defaults to "off": no wrapper element and no data-kohaku-disclosure anywhere in the DOM', () => {
    const { container } = renderSpec(L1_SPEC);
    expect(container.querySelector("[data-kohaku-disclosure]")).toBeNull();
    // The root of the rendered tree is the Spec's own root component, not an extra wrapper <div>.
    expect(container.firstElementChild?.getAttribute("data-kohaku")).toBe("root");
  });

  it('"off" passed explicitly renders identically to the prop being omitted (same DOM)', () => {
    const a = renderSpec(L1_SPEC, "off");
    const b = renderSpec(L1_SPEC);
    expect(a.container.innerHTML).toBe(b.container.innerHTML);
  });

  it('"attributes" wraps the tree in a div carrying the disclosure attributes, with no visible label text', () => {
    const { container } = renderSpec(L1_SPEC, "attributes");
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.getAttribute("data-kohaku-disclosure")).toBe("ai-generated");
    expect(wrapper.getAttribute("data-kohaku-tier")).toBe("L1");
    expect(wrapper.getAttribute("data-digital-source-type")).toBe("trainedAlgorithmicMedia");
    expect(screen.queryByText(DEFAULT_MESSAGES.disclosureAiGenerated)).toBeNull();
    // The actual Spec tree is still rendered inside the wrapper.
    expect(wrapper.querySelector('[data-kohaku="root"]')).not.toBeNull();
  });

  it('"label" additionally renders the visible KohakuDisclosureLabel text for ai-generated content', () => {
    renderSpec(L1_SPEC, "label");
    expect(screen.getByText(DEFAULT_MESSAGES.disclosureAiGenerated)).toBeDefined();
  });

  it('"label" renders the ai-assisted-reviewed text and digital-source-type for a fixated L0 Spec', () => {
    const { container } = renderSpec(L0_FIXATED_SPEC, "label");
    expect(screen.getByText(DEFAULT_MESSAGES.disclosureAiReviewed)).toBeDefined();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("data-kohaku-disclosure")).toBe("ai-assisted-reviewed");
    expect(wrapper.getAttribute("data-digital-source-type")).toBe("compositeWithTrainedAlgorithmicMedia");
  });

  it('"label" renders no visible text (and no data-digital-source-type) when the disclosure level is "none"', () => {
    const { container } = renderSpec(L0_NONE_SPEC, "label");
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.getAttribute("data-kohaku-disclosure")).toBe("none");
    expect(wrapper.hasAttribute("data-digital-source-type")).toBe(false);
    expect(screen.queryByText(DEFAULT_MESSAGES.disclosureAiGenerated)).toBeNull();
    expect(screen.queryByText(DEFAULT_MESSAGES.disclosureAiReviewed)).toBeNull();
  });
});
