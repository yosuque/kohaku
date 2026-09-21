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
   * pseudo). Splits the whole stylesheet on every `{`/`}` instead of trying to locate selector spans with
   * a boundary regex (a prior version anchored on `(^|})...\{` and additionally tried to strip a leading
   * `@media` prelude off the captured span — but `[^{}]*` can never itself contain the `{` that prelude
   * ends with, so that strip was dead code, and the span-boundary approach still missed the first selector
   * of any rule nested inside an at-rule, such as `.k-grid-2` in `@media (max-width:480px){.k-grid-2,...`,
   * because a `{` — the at-rule's own — precedes it there, not a `}`). Splitting on `{`/`}` sidesteps this
   * entirely: every selector list, declaration-block body, and at-rule prelude (`@media (...)`) becomes its
   * own token regardless of nesting. Declaration bodies and at-rule preludes need no special-casing — split
   * on `,` and stripped of any pseudo-class/pseudo-element, none of their parts can match
   * `^\.[a-z][a-z0-9-]*$` (a declaration never starts with a bare class token, and `@media (...)` starts
   * with `@`), so they fall through as non-matches. A class whose only rule carries a pseudo
   * (`.k-btn:hover`) still resolves to its plain class after the pseudo strip.
   */
  const extractSimpleClassSelectors = (css: string): Set<string> => {
    const found = new Set<string>();
    for (const token of css.split(/[{}]/)) {
      for (const rawPart of token.split(",")) {
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

  it("every kit class in the vocabulary has a selector in the CSS", () => {
    const missing = Object.keys(DEFAULT_KIT_VOCABULARY.classes).filter((c) => !hasSelector(c));
    expect(missing).toEqual([]);
  });

  it("every utility in the vocabulary has a selector in the CSS", () => {
    const missing = DEFAULT_KIT_VOCABULARY.utilities.filter((c) => !hasSelector(c));
    expect(missing).toEqual([]);
    // Guard against the check passing vacuously if `utilities` is ever emptied or truncated — 90 of its
    // 134 entries come from fifteen `[1,2,3,4,5,6].map(...)` spreads, exactly the construct a refactor shortens.
    expect(DEFAULT_KIT_VOCABULARY.utilities.length).toBeGreaterThanOrEqual(134);
  });

  it("every non-k- single-class selector in the CSS is a documented utility (no undocumented utilities)", () => {
    // Reverse partner of the "every utility in the vocabulary has a selector" test above: that one only
    // checks vocabulary -> CSS, so an emptied or truncated `utilities` array would still pass it silently.
    // This walks CSS -> vocabulary instead, the way the "every k-* selector..." test below already does
    // for kit classes — but for the utility (non "k-") namespace.
    const inCss = extractSimpleClassSelectors(defaultDesignKit.css);
    // Guard against the check passing vacuously if the extraction ever stops matching. 48 kit
    // classes + 134 utilities = 182 possible entries; 13 of them (the k-axis…k-line chart classes, which
    // per their own vocabulary descriptions only ever appear as compound/descendant selectors scoped
    // under .k-chart, e.g. ".k-chart .k-axis") never surface as a standalone single-class token, leaving
    // the actual walk at 169.
    expect(inCss.size).toBeGreaterThanOrEqual(169);
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

  it("every reserved namespace prefix has at least one utility or class behind it", () => {
    // A namespace with nothing behind it means the model can write the Tailwind-natural class (mx-auto,
    // pt-2, h-full, …) and get bounced by L2_UNKNOWN_CLASS every time — the bug commit 1 of this branch
    // fixes. Exclude nothing: if a prefix has no utility or class starting with it, this must fail.
    const known = [...Object.keys(DEFAULT_KIT_VOCABULARY.classes), ...DEFAULT_KIT_VOCABULARY.utilities];
    const uncovered = DEFAULT_KIT_VOCABULARY.namespaces.filter(
      (ns) => !known.some((name) => name.startsWith(ns)),
    );
    expect(uncovered).toEqual([]);
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

/**
 * n-5: machinizes the "classes are only ever ADDED within a version — never renamed or removed" compatibility
 * contract that, before this test, existed only as prose (renderer-core's design-kit.ts:15-16 and
 * docs/design.md's "Compatibility contract" note). The tests above only ever check *today's* vocabulary
 * against *today's* CSS, so a rename that touches both sides together (e.g. `k-btn` → `k-button` in both
 * KIT_UTILITIES/classes and the CSS selector) passes every one of them — the promise those two files make to
 * an already-promoted v1 artifact ("this class keeps rendering") would silently break with no test failure.
 *
 * This pins the full v1 name set (every `classes` key + every `utilities` entry, snapshotted below) and
 * asserts it stays a *subset* of the live set — additions pass, a rename or removal of any pinned name fails.
 *
 * How to update this pin when `defaultDesignKit.version` bumps past "1" (an incompatible break — exactly
 * what a version bump is for): once the bump is intentional, replace V1_PIN below with a fresh snapshot of
 * `[...Object.keys(DEFAULT_KIT_VOCABULARY.classes), ...DEFAULT_KIT_VOCABULARY.utilities]` taken at the new
 * version, rename this describe block and V1_PIN to say "v2", and update the `defaultDesignKit.version`
 * assertion below to "2" — that re-baselines the pin to start guarding v2's own promise going forward. Do
 * not simply delete or loosen this test to make a rename pass.
 */
const V1_PIN: readonly string[] = [
  // classes (48)
  "k-card",
  "k-card-title",
  "k-title",
  "k-subtitle",
  "k-muted",
  "k-num",
  "k-kpi",
  "k-kpi-label",
  "k-kpi-value",
  "k-kpi-delta",
  "k-btn",
  "k-btn-primary",
  "k-btn-secondary",
  "k-btn-danger",
  "k-table",
  "k-badge",
  "k-badge-positive",
  "k-badge-negative",
  "k-badge-warning",
  "k-badge-info",
  "k-notice",
  "k-notice-positive",
  "k-notice-negative",
  "k-notice-warning",
  "k-notice-info",
  "k-stack",
  "k-row",
  "k-grid",
  "k-grid-2",
  "k-grid-3",
  "k-grid-4",
  "k-label",
  "k-input",
  "k-select",
  "k-chart",
  "k-axis",
  "k-gridline",
  "k-tick",
  "k-axis-label",
  "k-series-1",
  "k-series-2",
  "k-series-3",
  "k-series-4",
  "k-series-5",
  "k-series-6",
  "k-series-7",
  "k-bar",
  "k-line",
  // utilities (134)
  "flex",
  "grid",
  "hidden",
  "w-full",
  "h-full",
  "flex-col",
  "flex-wrap",
  "items-center",
  "items-start",
  "justify-between",
  "justify-end",
  "grid-cols-2",
  "grid-cols-3",
  "grid-cols-4",
  ...[1, 2, 3, 4, 5, 6].map((n) => `gap-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `p-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `px-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `py-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pt-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pb-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pl-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pr-${n}`),
  "m-0",
  ...[1, 2, 3, 4, 5, 6].map((n) => `m-${n}`),
  "mx-auto",
  ...[1, 2, 3, 4, 5, 6].map((n) => `mx-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `my-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `mt-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `mb-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `ml-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `mr-${n}`),
  "text-xs",
  "text-sm",
  "text-md",
  "text-lg",
  "text-xl",
  "text-2xl",
  "text-muted",
  "text-primary",
  "text-positive",
  "text-negative",
  "text-left",
  "text-center",
  "text-right",
  "truncate",
  "tabular-nums",
  "font-medium",
  "font-semibold",
  "font-bold",
  "rounded-sm",
  "rounded-md",
  "rounded-lg",
  "rounded-full",
  "shadow-sm",
  "shadow-md",
  "border",
  "border-b",
  "bg-surface",
  "bg-background",
];

describe("design-kit v1 compatibility pin (additions only — a rename or removal must fail this test)", () => {
  it("the live class/utility set is a superset of the pinned v1 name set", () => {
    // If this fails because defaultDesignKit.version is no longer "1", see the "How to update this pin"
    // comment above V1_PIN — a version bump is the intended way to make an incompatible change; re-baseline
    // the pin, do not just delete this assertion.
    expect(defaultDesignKit.version).toBe("1");
    const live = new Set([
      ...Object.keys(DEFAULT_KIT_VOCABULARY.classes),
      ...DEFAULT_KIT_VOCABULARY.utilities,
    ]);
    const renamedOrRemoved = V1_PIN.filter((name) => !live.has(name));
    expect(renamedOrRemoved).toEqual([]);
  });
});
