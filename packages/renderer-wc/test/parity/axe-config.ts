// Shared axe-core configuration for the a11y parity checks (a11y.test.ts).
//
// jsdom has no layout engine (no real box model, no canvas 2D context, no CSSOM cascade against a rendered
// tree), so any axe rule whose verdict depends on *computed visual appearance* — pixel color sampling, element
// size/position, scroll overflow — cannot be evaluated meaningfully here: it would either throw, always report
// "incomplete", or produce a result that says nothing about the generated UI Spec. Those rules stay in scope for
// a real-browser / visual-regression check (out of scope for this parity harness) and are disabled below.
//
// The parity harness also renders an isolated component fragment (a `<div>`/shadow-root subtree appended
// directly under document.body), not a full page shell with <title>/<html lang>/a single <main> landmark — that
// shell is the host app's responsibility, not an individual generated component's. Page-level document-metadata
// and landmark-uniqueness rules are disabled for the same reason: they check things this harness never has (or
// intentionally leaves to the host page), not a defect in the rendered component.
export const AXE_DISABLED_RULES = [
  // --- Requires real layout / rendering (no-op or unreliable under jsdom) -----------------------------------
  "color-contrast", // needs canvas-based pixel sampling against actual paint
  "color-contrast-enhanced", // same (AAA variant)
  "target-size", // needs a real bounding rect (jsdom layout is not computed)
  "scrollable-region-focusable", // needs real overflow/scroll computation
  "css-orientation-lock", // needs viewport/media-query evaluation
  "link-in-text-block", // its contrast sub-check has the same canvas dependency as color-contrast

  // --- Page-level document/landmark rules (not applicable to an isolated component fragment) -----------------
  "region",
  "landmark-one-main",
  "landmark-complementary-is-top-level",
  "landmark-banner-is-top-level",
  "landmark-contentinfo-is-top-level",
  "landmark-main-is-top-level",
  "landmark-no-duplicate-banner",
  "landmark-no-duplicate-contentinfo",
  "landmark-no-duplicate-main",
  "landmark-unique",
  "page-has-heading-one",
  "bypass",
  "skip-link",
  "document-title",
  "html-has-lang",
  "html-lang-valid",
  "html-xml-lang-mismatch",
  "meta-viewport",
  "meta-viewport-large",
] as const;

/** axe.run options shared by every a11y parity check: structural/semantic rules only, scoped to a rendered fragment. */
export const AXE_OPTIONS: import("axe-core").RunOptions = {
  resultTypes: ["violations"],
  rules: Object.fromEntries(AXE_DISABLED_RULES.map((id) => [id, { enabled: false }])),
};
