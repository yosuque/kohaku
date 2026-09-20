import { DEFAULT_KIT_VOCABULARY } from "@kohaku-ui/composer/design-system";
import { defaultDesignKit, defaultLightTheme, sandboxThemeCss } from "@kohaku-ui/renderer-core";
import { describe, expect, it } from "vitest";

/**
 * The two wheels of the design kit: composer's vocabulary (what the model is told exists) and
 * renderer-core's CSS (what the sandbox injects). They live in different packages by the layering rule
 * (composer must not depend on renderer-core), so this test — in sandbox, which depends on both — is
 * what keeps them from drifting.
 */
describe("design-kit contract (composer vocabulary ⇄ renderer-core CSS)", () => {
  const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasSelector = (cls: string): boolean =>
    new RegExp(`\\.${escapeRegExp(cls)}(?![\\w-])`).test(defaultDesignKit.css);

  /**
   * Extracts every "exactly one `.class` token" selector in the CSS — the selector, or one entry of a
   * comma-separated selector list, that is nothing but a class name (no combinator, no element, no
   * pseudo). Unlike a boundary regex anchored on `(^|})...\{` (which misses a class first in a
   * comma-separated list like `.k-input,.k-select{...}`, since nothing but that same list separates it
   * from the previous rule's `}`, and misses the first selector of a rule nested inside an at-rule like
   * `@media (max-width:480px){.k-grid-2,...`, since a `{` — the at-rule's own — precedes it, not a `}`),
   * this walks every "text immediately after the last `}` (or start), up to the next `{`" span — which
   * for an at-rule-nested rule still swallows the at-rule's own prelude (`@media (max-width:480px){`),
   * stripped explicitly — then splits that span on `,`, strips any pseudo-class/pseudo-element so a class
   * whose only rule carries one (`.k-btn:hover`) still resolves to its plain class, and keeps only the
   * parts that are exactly `.` + a class name.
   */
  const extractSimpleClassSelectors = (css: string): Set<string> => {
    const found = new Set<string>();
    for (const m of css.matchAll(/(?:^|\})([^{}]*)\{/g)) {
      const head = m[1]!.replace(/^@media[^{]*\{/, "");
      for (const rawPart of head.split(",")) {
        const stripped = rawPart.replace(/:[a-z-]+(\([^)]*\))?/g, "").trim();
        if (/^\.[a-z][a-z0-9-]*$/.test(stripped)) found.add(stripped.slice(1));
      }
    }
    return found;
  };

  it("id and version match", () => {
    expect(DEFAULT_KIT_VOCABULARY.id).toBe(defaultDesignKit.id);
    expect(DEFAULT_KIT_VOCABULARY.version).toBe(defaultDesignKit.version);
  });

  it("every component class in the vocabulary has a selector in the CSS", () => {
    const missing = Object.keys(DEFAULT_KIT_VOCABULARY.classes).filter((c) => !hasSelector(c));
    expect(missing).toEqual([]);
  });

  it("every utility in the vocabulary has a selector in the CSS", () => {
    const missing = DEFAULT_KIT_VOCABULARY.utilities.filter((c) => !hasSelector(c));
    expect(missing).toEqual([]);
    // Guard against the check passing vacuously if `utilities` is ever emptied or truncated — 36 of its
    // 78 entries come from six `[1,2,3,4,5,6].map(...)` spreads, exactly the construct a refactor shortens.
    expect(DEFAULT_KIT_VOCABULARY.utilities.length).toBeGreaterThanOrEqual(78);
  });

  it("every non-k- single-class selector in the CSS is a documented utility (no undocumented utilities)", () => {
    // Reverse partner of the "every utility in the vocabulary has a selector" test above: that one only
    // checks vocabulary -> CSS, so an emptied or truncated `utilities` array would still pass it silently.
    // This walks CSS -> vocabulary instead, the way the "every k-* selector..." test below already does
    // for component classes — but for the utility (non "k-") namespace.
    const inCss = extractSimpleClassSelectors(defaultDesignKit.css);
    // Guard against the check passing vacuously if the extraction regex ever stops matching (it currently
    // finds all 48 component classes + 78 utilities minus a small handful defined only via compound/
    // descendant selectors that never appear as a standalone single-class token, i.e. comfortably >= 100).
    expect(inCss.size).toBeGreaterThanOrEqual(100);
    const utilities = new Set(DEFAULT_KIT_VOCABULARY.utilities);
    // is-up / is-down are state modifiers advertised through k-kpi-delta's description and the DEFAULT_KIT_SKELETON,
    // not utilities — excluded explicitly rather than relying on them never becoming a standalone selector.
    const undocumented = [...inCss].filter(
      (c) => !c.startsWith("k-") && c !== "is-up" && c !== "is-down" && !utilities.has(c),
    );
    // If this fails, the kit CSS grew a utility the vocabulary never told the model about — do not relax
    // this check; fix the drift (add the class to KIT_UTILITIES, in both TS and Python) instead.
    expect(undocumented).toEqual([]);
  });

  it("every k-* selector in the CSS is in the vocabulary (no undocumented classes)", () => {
    const inCss = new Set<string>();
    for (const m of defaultDesignKit.css.matchAll(/\.(k-[a-z0-9-]+)/g)) inCss.add(m[1]!);
    const undocumented = [...inCss].filter((c) => !(c in DEFAULT_KIT_VOCABULARY.classes));
    expect(undocumented).toEqual([]);
  });

  it("every var(--kohaku-…) the kit CSS references is emitted by sandboxThemeCss", () => {
    const referenced = [
      ...new Set([...defaultDesignKit.css.matchAll(/var\((--kohaku-[a-z0-9-]+)\)/g)].map((m) => m[1]!)),
    ].sort();
    const emitted = sandboxThemeCss(defaultLightTheme);
    const missing = referenced.filter((name) => !emitted.includes(`${name}:`));
    expect(missing).toEqual([]);
    // Guard against the check passing vacuously if the regex ever stops matching.
    expect(referenced.length).toBeGreaterThan(20);
  });
});
