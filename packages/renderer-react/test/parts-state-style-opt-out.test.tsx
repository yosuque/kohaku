// Kept in its own file (own jsdom document) for the same reason as parts-state-style-nonce.test.tsx:
// React 19's <style href="kohaku-parts-state"> resource is never removed on unmount, so a prior test in a
// shared file that already rendered the default (injecting) RendererProvider would leave the stylesheet
// permanently present, making a `stateStyles: false` assertion here order-dependent rather than a
// property of this option alone.
import { PARTS_STATE_CSS } from "@kohaku-ui/renderer-core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider } from "../src/index.js";

function countStateStyles(): number {
  return [...document.querySelectorAll("style")].filter((s) => s.textContent === PARTS_STATE_CSS).length;
}

describe("RendererContextValue.stateStyles: false", () => {
  it("skips injecting the theme-neutral state stylesheet entirely", () => {
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), theme: {}, stateStyles: false }}>
        <div />
      </RendererProvider>,
    );
    expect(countStateStyles()).toBe(0);
  });
});
