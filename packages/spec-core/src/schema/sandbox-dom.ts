/**
 * The DOM mutation-applier allowlist for the L2 sandbox's worker-executed runtime (packages/sandbox's
 * `guest/dom-applier.ts`). Pure constants and pure predicate functions only (spec-core is environment-neutral:
 * no DOM lib, no @types/node).
 *
 * The generated L2 script runs in a Worker with no `document` of its own (see spec/SPEC.md SBX-EXEC-001); it
 * expresses DOM mutations as short-array ops relayed through the trusted iframe document, and the document's
 * applier is the single place that decides which tags / attributes / style properties are actually allowed to
 * reach the real DOM. This module is that single source of truth, shared by:
 * - `packages/sandbox/src/guest/dom-applier.ts` (the enforcement point, iframe document side)
 * - `python/kohaku/src/kohaku/spec/sandbox_dom.py` (a mirror kept in sync by the cross-language golden in
 *   `spec/test/fixtures/cross-language-canonical.json`; Python has no sandbox runtime of its own, so the
 *   mirror exists purely to pin that the allowlist itself does not drift between the two languages)
 *
 * Everything here is restrict-only / fail-closed: an unknown tag, attribute, or style property is always
 * rejected, never passed through. There is no per-tag attribute scoping (e.g. `value` is allowed on any
 * element, not only `<input>`) — this is a deliberate simplification documented here rather than in each
 * call site: none of the listed attributes has a cross-tag privilege-escalation meaning, so the reduced
 * bookkeeping is worth the small loss of precision.
 */

/** Elements the applier may create. Anything else (including script/style/iframe/object/embed/a/img/form) is denied. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  // HTML
  "div",
  "span",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "code",
  "pre",
  "br",
  "hr",
  "button",
  "label",
  "input",
  "select",
  "option",
  "textarea",
  "section",
  "article",
  "header",
  "footer",
  "figure",
  "figcaption",
  // SVG
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "lineargradient",
  "stop",
  "clippath",
  "title",
]);

/** Elements explicitly called out as denied by the design (kept here only for documentation/tests — absence from ALLOWED_TAGS already denies them). */
export const EXPLICITLY_DENIED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "img",
  "form",
  "iframe",
  "object",
  "embed",
  "script",
  "style",
  "link",
  "meta",
  "base",
  "template",
  "foreignobject",
  "use",
  "image",
]);

/** Void HTML elements (no children, no closing tag) — used by the innerHTML parser. */
export const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "input"]);

/** Global attributes allowed on any allowed element. `aria-*` / `data-*` are matched by prefix (see isAttrAllowed). */
const GLOBAL_ATTRS: ReadonlySet<string> = new Set(["id", "class", "title", "role", "tabindex", "hidden"]);

/** Attributes meaningful on form-control-like elements. */
const INPUT_ATTRS: ReadonlySet<string> = new Set([
  "type",
  "value",
  "placeholder",
  "disabled",
  "checked",
  "selected",
  "name",
  "min",
  "max",
  "step",
  "rows",
  "cols",
]);

/** Table-layout attributes. */
const TABLE_ATTRS: ReadonlySet<string> = new Set(["colspan", "rowspan", "scope"]);

/** SVG geometry / paint / transform attributes. */
const SVG_ATTRS: ReadonlySet<string> = new Set([
  "d",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "opacity",
  "fill-opacity",
  "stroke-opacity",
  "transform",
  "viewbox",
  "preserveaspectratio",
  "text-anchor",
  "font-size",
  "font-family",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "clip-path",
]);

/** The union of every allowed attribute name (lowercase), excluding the aria- and data- prefix families (see ALLOWED_ATTR_PREFIXES). */
export const ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  ...GLOBAL_ATTRS,
  ...INPUT_ATTRS,
  ...TABLE_ATTRS,
  ...SVG_ATTRS,
]);

/** Attribute-name prefixes always allowed (aria-* / data-*). */
export const ALLOWED_ATTR_PREFIXES: readonly string[] = ["aria-", "data-"];

/**
 * Attributes that are always rejected even if they happen to also appear textually in ALLOWED_ATTRS (defense
 * in depth: the applier checks this set FIRST, before consulting the allowlist). `on*` is matched by prefix.
 */
export const ALWAYS_DENIED_ATTRS: ReadonlySet<string> = new Set([
  "href",
  "xlink:href",
  "src",
  "srcdoc",
  "srcset",
  "action",
  "formaction",
  "ping",
  "target",
  "download",
  "is",
  "style",
]);

/** DOM properties (not attributes) the applier's property-op (`["y", id, prop, value]`) may write. */
export const ALLOWED_PROPERTY_OPS: ReadonlySet<string> = new Set([
  "value",
  "checked",
  "disabled",
  "selected",
  "scrollTop",
  "scrollLeft",
  "hidden",
  "indeterminate",
]);

/** Inline-style properties the applier's style-op (`["p", id, prop, value]`) may write (camelCase or kebab-case, matched case-insensitively after kebab-casing). */
export const ALLOWED_STYLE_PROPS: ReadonlySet<string> = new Set([
  // box
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "box-sizing",
  "box-shadow",
  "aspect-ratio",
  // flex
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "justify-content",
  "align-items",
  "align-content",
  "align-self",
  "order",
  // grid
  "gap",
  "row-gap",
  "column-gap",
  "grid-template-columns",
  "grid-template-rows",
  "grid-column",
  "grid-row",
  "grid-auto-flow",
  "grid-gap",
  // typography
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-transform",
  "text-overflow",
  "white-space",
  "word-break",
  "word-wrap",
  "vertical-align",
  // color / paint
  "color",
  "background",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "opacity",
  "fill",
  "stroke",
  "stroke-width",
  // border / outline
  "border",
  "border-width",
  "border-style",
  "border-color",
  "border-radius",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-collapse",
  "border-spacing",
  "outline",
  "outline-color",
  "outline-width",
  "outline-style",
  // transform / transition
  "transform",
  "transform-origin",
  "transition",
  "transition-property",
  "transition-duration",
  "transition-timing-function",
  // misc
  "overflow",
  "overflow-x",
  "overflow-y",
  "cursor",
  "visibility",
  "z-index",
  "list-style",
  "list-style-type",
  "table-layout",
]);

/** Converts a camelCase CSS property name (as seen via `style.propName = …`) to kebab-case for allowlist lookup. */
export function toKebabCase(prop: string): string {
  return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function isTagAllowed(tag: string): boolean {
  return ALLOWED_TAGS.has(tag.toLowerCase());
}

/** True when `value` (an href/src/etc. — anything the applier lets through unfiltered) contains a `javascript:` scheme. */
export function containsJavascriptScheme(value: string): boolean {
  return /javascript\s*:/i.test(value);
}

export function isAttrAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  if (ALWAYS_DENIED_ATTRS.has(lower) || lower.startsWith("on")) return false;
  if (ALLOWED_ATTR_PREFIXES.some((p) => lower.startsWith(p))) return true;
  return ALLOWED_ATTRS.has(lower);
}

/** Attribute-value safety check applied on top of isAttrAllowed (rejects a javascript: scheme in any accepted attribute value). */
export function isAttrValueSafe(value: string): boolean {
  return !containsJavascriptScheme(value);
}

export function isStylePropAllowed(prop: string): boolean {
  return ALLOWED_STYLE_PROPS.has(toKebabCase(prop).toLowerCase());
}

/**
 * Style-value safety check: `url(...)` is allowed only as a same-document fragment reference (`url(#id)`);
 * any other `url(` (an external resource load) and any `expression(` / `@import` (legacy IE script execution /
 * CSS-triggered cross-origin loads) are rejected.
 */
export function isStyleValueSafe(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes("expression(") || lower.includes("@import")) return false;
  for (const m of lower.matchAll(/url\(\s*['"]?([^'")]*)['"]?\s*\)/g)) {
    if (!m[1]!.startsWith("#")) return false;
  }
  return true;
}

/** Default DOM-shape limits (see SandboxPolicy in packages/sandbox — the applier enforces these). */
export const DEFAULT_MAX_DOM_NODES = 20_000;
export const DEFAULT_MAX_DOM_DEPTH = 64;
export const DEFAULT_MUTATIONS_PER_MINUTE = 6000;
