// Parity of the L2 sandbox chrome (the "L2 SANDBOXED" badge + its status notice) between React
// (SandboxFrame, @kohaku-ui/sandbox/react) and WC (mountSandboxNode, ../../src/sandbox-mount.js).
// Both now consume renderer-core's sandbox-chrome presenter as the single source of truth for
// wording/colors — this test guards against the two drifting again the way they had before
// extraction (verbatim-duplicated strings/hex values in each renderer's own file).
//
// mountSandbox itself (the real iframe + postMessage handshake) does not run to completion in
// jsdom, so it is mocked deterministically straight into the "error" state, mirroring the technique
// already used by packages/sandbox/test/react.test.tsx (mocks the relative ./mount.js import used by
// SandboxFrame) and renderer-wc/test/phase3-sandbox.test.ts (mocks the @kohaku-ui/sandbox package
// import used by mountSandboxNode). Both specifiers resolve to the same underlying mount.ts file, so
// mocking both here exercises both renderers off one fake implementation.
//
// Note: WC keeps a persistent "statusHolder" wrapper div around the notice (so a state transition can
// replace just its children without rebuilding the whole part), while React renders the notice as a
// direct sibling — a pre-existing structural difference unrelated to this refactor. So rather than
// asserting full-subtree DOM equality, this test (a) asserts the badge row itself — which IS at the
// same nesting depth in both — is byte-identical, and (b) asserts the depth-first sequence of visible
// text (badge label, badge description, notice text) is identical, which is what "the chrome wording
// matches" actually means and is robust to that nesting difference.

import type { SandboxHandle } from "@kohaku-ui/sandbox";
import { SandboxFrame } from "@kohaku-ui/sandbox/react";
import { type ComponentNode, parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SemanticChild, SemanticNode } from "./normalize.js";
import { cleanupPair, normalize, renderReact, renderWc } from "./render-both.js";

const ERROR_DETAIL = "guest runtime error";

function fakeMountSandbox(): SandboxHandle {
  return {
    state: "loading",
    // Fires synchronously so both renderers observe "error" by the time we inspect the DOM (no
    // need to wait out a real handshake timeout).
    onStateChange: (listener) => listener("error", ERROR_DETAIL),
    updateProps: () => {},
    invalidate: () => {},
    destroy: () => {},
  };
}

// WC's mountSandboxNode imports mountSandbox from the package root ("@kohaku-ui/sandbox" → src/index.ts).
vi.mock("@kohaku-ui/sandbox", () => ({ mountSandbox: fakeMountSandbox }));
// SandboxFrame imports mountSandbox from the relative "./mount.js" (src/mount.ts) — a different
// specifier resolving to the same file that src/index.ts re-exports, so it needs its own mock.
vi.mock("../../../sandbox/src/mount.js", () => ({ mountSandbox: fakeMountSandbox }));

const INTENT = { canonical: "parity.sandbox", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L2", composedBy: "parity", cache: "hit" } as const;
const SHA = "a".repeat(64);
const HTML = "<html><body>x</body></html>";

function sandboxSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      {
        id: "root",
        type: "sandbox.html",
        props: {},
        artifact: { inline: HTML, sha256: SHA },
      },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

const bridge = {
  resolveBinding: async () => ({ columns: [], rows: [], dataVersion: "v1" }),
  onEvent: () => {},
  onTelemetry: () => {},
};

/** Depth-first flattening of all visible text leaves, in document order. */
function collectTexts(node: SemanticNode): string[] {
  const out: string[] = [];
  for (const child of node.children as SemanticChild[]) {
    if ("text" in child) out.push(child.text);
    else out.push(...collectTexts(child));
  }
  return out;
}

describe("L2 sandbox chrome parity: React tree ≡ WC tree for the badge + error notice", () => {
  afterEach(() => cleanupPair());

  it("badge text and error-notice text match between renderers", async () => {
    const spec = sandboxSpec();

    const { container } = await renderReact(spec, {
      renderSandbox: (node: ComponentNode, s: UISpec) =>
        createElement(SandboxFrame, { node, spec: s, bridge }),
    });
    const { surface } = await renderWc(spec, { sandbox: { bridge } });

    const react = normalize(container.querySelector('[data-kohaku="root"]')!);
    const wc = normalize(surface.shadowRoot!.querySelector('[data-kohaku="root"]')!);

    // The badge row is the first child in both renderers, at the same nesting depth — full structural
    // equality is meaningful here (unlike the notice, see the file-level comment above).
    const badgeRowOf = (node: SemanticNode): SemanticChild => node.children[0]!;
    expect(badgeRowOf(wc)).toEqual(badgeRowOf(react));

    // The full wording sequence (badge label, badge description, then the error notice) is identical
    // regardless of the extra WC-only statusHolder wrapper around the notice.
    const texts = collectTexts(react);
    expect(texts).toEqual(["L2 SANDBOXED", expect.stringContaining("isolated iframe"), ERROR_DETAIL]);
    expect(collectTexts(wc)).toEqual(texts);
  });
});
