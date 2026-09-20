/**
 * H10: one shared vector table run against BOTH sanitiser allow-lists for the same threat model —
 * spec-core's predicates (`packages/spec-core/test/sandbox-dom.test.ts`) and the sandbox guest DOM applier,
 * driven through the real `domApplierMain` (`packages/sandbox/test/guest/dom-applier.test.ts`). Without a
 * single shared table the two allow-lists are tested separately and can drift apart without either suite
 * noticing.
 *
 * Deliberately lives under spec-core's `test/` (not `src/`) so spec-core's published `exports` does not grow
 * for a fixture with no production use. The sandbox package reaches it with a relative, test-only import
 * (`../../../spec-core/test/fixtures/sandbox-allowlist-vectors.js`) rather than through spec-core's public
 * API — sandbox already depends on `@kohaku-ui/spec-core` at runtime, so this adds no new coupling, only a
 * test-time one.
 *
 * Every vector's expected outcome is the SAME on both sides, with exactly one documented exception: `#text`
 * (see TAG_VECTORS below), which the applier accepts and spec-core's `isTagAllowed` does not, by design.
 */

export interface TagVector {
  readonly tag: string;
  /** Expected `isTagAllowed(tag)` result in spec-core (packages/spec-core/src/schema/sandbox-dom.ts). */
  readonly specCore: boolean;
  /**
   * Expected outcome when the same tag is driven through the real `domApplierMain`: whether a `"c"` op
   * creating this tag (then appended under body) lands a node in the real DOM.
   */
  readonly applier: boolean;
}

export const TAG_VECTORS: readonly TagVector[] = [
  { tag: "div", specCore: true, applier: true },
  { tag: "script", specCore: false, applier: false },
  { tag: "iframe", specCore: false, applier: false },
  { tag: "svg", specCore: true, applier: true },
  // Text nodes are created by the applier itself (the "c" op's `tag === "#text"` branch) and are never named
  // by generated markup, so the applier's own isTagAllowed accepts "#text" while spec-core's does not — see
  // the comment above isTagAllowed in packages/sandbox/src/guest/dom-applier.ts.
  { tag: "#text", specCore: false, applier: true },
  { tag: "DIV", specCore: true, applier: true },
];

export interface AttrVector {
  readonly name: string;
  readonly value: string;
  /** Expected `isAttrAllowed(name)` result — name only, independent of value. */
  readonly attrAllowed: boolean;
  /** Expected `isAttrValueSafe(value)` result — value only, independent of name. */
  readonly valueSafe: boolean;
}

export const ATTR_VECTORS: readonly AttrVector[] = [
  { name: "id", value: "widget-1", attrAllowed: true, valueSafe: true },
  { name: "onclick", value: "doThing()", attrAllowed: false, valueSafe: true },
  { name: "href", value: "javascript:alert(1)", attrAllowed: false, valueSafe: false },
  { name: "srcdoc", value: "<p>x</p>", attrAllowed: false, valueSafe: true },
  { name: "cx", value: "10", attrAllowed: true, valueSafe: true },
  { name: "style", value: "color:red", attrAllowed: false, valueSafe: true },
];

export interface StyleValueVector {
  /** An allowed style property held constant per row, so the vector isolates value safety. */
  readonly prop: string;
  readonly value: string;
  /** Expected `isStyleValueSafe(value)` result. */
  readonly safe: boolean;
}

export const STYLE_VALUE_VECTORS: readonly StyleValueVector[] = [
  { prop: "background-image", value: "url(#g)", safe: true },
  { prop: "background-image", value: "url(http://x)", safe: false },
  // These two rows replace `{ prop: "width", value: "expression(alert(1))" }` and
  // `{ prop: "color", value: "@import url(evil.css)" }`, which duplicated `sandbox-dom.test.ts` and were
  // tautological on the applier side: cssstyle rejects both as invalid CSS outright, so they could never
  // detect a drift between the two allow-lists. Wrapping the same substrings inside a syntactically valid
  // `url(...)` value is accepted by cssstyle (verified empirically) while `isStyleValueSafe`'s
  // `expression(`/`@import` substring check still rejects it, so these actually exercise the allow-list.
  { prop: "background-image", value: 'url("http://x/?e=expression(1)")', safe: false },
  { prop: "background-image", value: 'url("@import.css")', safe: false },
  { prop: "color", value: "red", safe: true },
  { prop: "background-image", value: "URL(#X)", safe: true },
];
