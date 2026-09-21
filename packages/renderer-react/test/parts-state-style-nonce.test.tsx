// Kept in its own file (own jsdom document) rather than folded into parts-state-style.test.tsx: React 19
// de-dupes the injected <style href="kohaku-parts-state"> as a document-level resource that is NOT removed
// on unmount, so whichever test in a shared file renders the RendererProvider FIRST permanently decides
// whether that resource carries a `nonce` attribute for the rest of the file. Isolating this scenario in
// its own file (vitest gives each test file a fresh jsdom environment) avoids that ordering trap entirely.
import { PARTS_STATE_CSS } from "@kohaku-ui/renderer-core";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider } from "../src/index.js";

function stateStyleEl(): HTMLStyleElement | undefined {
  return [...document.querySelectorAll("style")].find((s) => s.textContent === PARTS_STATE_CSS) as
    | HTMLStyleElement
    | undefined;
}

describe("RendererContextValue.stateStylesNonce", () => {
  it("sets the injected <style>'s nonce attribute (a strict style-src-elem CSP host)", () => {
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), theme: {}, stateStylesNonce: "abc123" }}>
        <div />
      </RendererProvider>,
    );
    const style = stateStyleEl();
    expect(style).toBeDefined();
    expect(style!.getAttribute("nonce")).toBe("abc123");
  });
});
