import { PARTS_STATE_CSS } from "@kohaku-ui/renderer-core";
import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

function countStateStyles(): number {
  return [...document.querySelectorAll("style")].filter((s) => s.textContent === PARTS_STATE_CSS).length;
}

/**
 * A Spec whose ROOT component (id "root") is itself action.button, with no wrapping layout.stack —
 * the shape needed to prove the state stylesheet's "own root" companion selectors (`button[data-kohaku]`,
 * `[data-kohaku]:focus-visible`), not just its descendant-combinator half, since a part carries
 * `data-kohaku` on its own root element and an element is not its own descendant.
 */
function rootButtonSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [{ id: "root", type: "action.button", props: { label: "Run" } }],
    events: [],
    provenance: PROVENANCE,
  });
}

describe("RendererProvider injects the theme-neutral L1 state stylesheet once", () => {
  it("one <style> holding PARTS_STATE_CSS exists even with two providers mounted", () => {
    render(
      <>
        <RendererProvider value={{ impls: createCoreRegistry(), theme: {} }}>
          <div />
        </RendererProvider>
        <RendererProvider value={{ impls: createCoreRegistry(), theme: { "color.primary": "#000" } }}>
          <div />
        </RendererProvider>
      </>,
    );
    expect(countStateStyles()).toBe(1);
  });

  // (Task 5 review finding I-2): a nested action button passes whether or not the "own root" companion
  // selectors (button[data-kohaku], [data-kohaku]:focus-visible) exist -- only a Spec whose ROOT
  // component is action.button proves they actually bite. jsdom cannot simulate :hover, so this is
  // selector-matching (Element.matches), not an interaction test.
  it("the state stylesheet's button and focus rules match a ROOT-level action button", () => {
    const { container } = render(
      <RendererProvider value={{ impls: createCoreRegistry(), theme: {} }}>
        <SpecView spec={rootButtonSpec()} />
      </RendererProvider>,
    );
    const btn = container.querySelector("button[data-kohaku]");
    expect(btn).not.toBeNull();

    const strip = (selector: string): string =>
      selector.replace(/:not\(:disabled\)|:hover|:active|:focus-visible/g, "").trim();
    // A selector only proves anything about a ROOT-level element (no ancestor carries data-kohaku) when
    // it attaches its state pseudo-class directly to the [data-kohaku] element itself, i.e. carries no
    // combinator whitespace ("anchored"). This must be checked on the RAW (pre-strip) selector: strip's
    // regex deletes the whole `:focus-visible` token, so a genuinely descendant selector like
    // "[data-kohaku] :focus-visible" degrades to "[data-kohaku] " and then trim() silently erases the
    // very whitespace this check exists to detect, collapsing it to the same string as the anchored
    // "[data-kohaku]:focus-visible" -- which is exactly why an un-anchored check here is vacuous.
    const anchored = (raw: string): boolean => !raw.trim().includes(" ");

    const rules = PARTS_STATE_CSS.split("}").filter((r) => r.trim() !== "");
    const buttonRules = rules.filter((r) => r.includes("button"));
    expect(buttonRules.length).toBeGreaterThan(0);
    for (const rule of buttonRules) {
      const rawSelectors = rule.slice(0, rule.indexOf("{")).split(",");
      expect(
        rawSelectors.some((raw) => anchored(raw) && btn!.matches(strip(raw))),
        rule,
      ).toBe(true);
    }

    // The focus rule reaches the attributed element itself, not only its descendants.
    const focusRule = rules.find((r) => r.includes(":focus-visible"));
    expect(focusRule).toBeDefined();
    const focusRawSelectors = focusRule!.slice(0, focusRule!.indexOf("{")).split(",");
    expect(focusRawSelectors.some((raw) => anchored(raw) && btn!.matches(strip(raw)))).toBe(true);
  });
});
