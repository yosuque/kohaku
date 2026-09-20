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

import { defaultDarkTheme } from "@kohaku-ui/renderer-core";
import type { SandboxHandle } from "@kohaku-ui/sandbox";
import { SandboxFrame } from "@kohaku-ui/sandbox/react";
import { type ComponentNode, parseSpec, type ThemeTokens, type UISpec } from "@kohaku-ui/spec-core";
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

/**
 * Normalizes a color string through jsdom's CSSOM the same way normalize.ts's `styleOf` does (both read
 * back through `element.style`, which jsdom rewrites — e.g. a hex literal comes back as `rgb(...)`), so a
 * pinned expectation can be compared apples-to-apples against a DOM-read-back style value.
 */
function cssColor(value: string): string {
  const probe = document.createElement("div");
  probe.style.color = value;
  return probe.style.color;
}

/** Depth-first flattening of all visible text leaves, in document order. */
function collectTexts(node: SemanticNode): string[] {
  const out: string[] = [];
  for (const child of node.children as SemanticChild[]) {
    if ("text" in child) out.push(child.text);
    else out.push(...collectTexts(child));
  }
  return out;
}

/**
 * Renders both renderers against the same (optional) theme and returns their normalized root nodes.
 *
 * The React side's `renderSandbox` callback must explicitly forward `theme` to `<SandboxFrame>` —
 * renderer-react's SpecView does not inject it automatically (`renderSandbox`'s signature is plain
 * `(node, spec) => ReactNode`, see SpecView.tsx). This mirrors how production wiring does it
 * (apps/sample-web's SpecSurface.tsx closes over its own `theme` and passes `theme={theme}` into
 * SandboxFrame) — closing over the same `theme` this function received, rather than leaving it implicit,
 * is exactly what makes this a same-input comparison instead of two renderers that happen to agree only
 * because both silently defaulted to `{}`.
 */
async function renderChromePair(theme?: ThemeTokens): Promise<{ react: SemanticNode; wc: SemanticNode }> {
  const spec = sandboxSpec();

  const { container } = await renderReact(spec, {
    theme,
    renderSandbox: (node: ComponentNode, s: UISpec) =>
      createElement(SandboxFrame, { node, spec: s, bridge, theme }),
  });
  const { surface } = await renderWc(spec, { theme, sandbox: { bridge } });

  return {
    react: normalize(container.querySelector('[data-kohaku="root"]')!),
    wc: normalize(surface.shadowRoot!.querySelector('[data-kohaku="root"]')!),
  };
}

describe("L2 sandbox chrome parity: React tree ≡ WC tree for the badge + error notice", () => {
  afterEach(() => cleanupPair());

  it("badge text and error-notice text match between renderers (default theme)", async () => {
    const { react, wc } = await renderChromePair();

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

  // Since tokenization, the chrome's colors/sizes come from `theme` rather than literal hex, so the two
  // renderers only agree if the SAME theme value actually reaches both. The default-theme case above
  // cannot catch a renderer that silently drops theme (e.g. a renderSandbox wiring that forgets to
  // forward it) — both sides would coincidentally land on the same default-light values regardless of
  // whether theme was threaded through at all. Exercising a non-default theme makes that failure mode
  // observable: React and WC diverge under a dropped theme, and only match here by actually agreeing.
  it("badge row matches between renderers under a non-default theme (dark)", async () => {
    const { react, wc } = await renderChromePair(defaultDarkTheme);

    const badgeRowOf = (node: SemanticNode): SemanticChild => node.children[0]!;
    expect(badgeRowOf(wc)).toEqual(badgeRowOf(react));

    // Pin against the actual dark-theme token value (not just "React === WC") so a bug that resolves both
    // sides identically but against the wrong (e.g. light-default) theme would still be caught.
    const badgeRow = badgeRowOf(react) as SemanticNode;
    expect(badgeRow.style.color).toBe(cssColor(String(defaultDarkTheme["color.warning.text"])));
  });
});
