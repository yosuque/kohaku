// Groundwork for the raw-DOM builders. Generating strings equivalent to React's inline-style expansion is
// the mechanism behind pixel-match. The px-suffixing rules for style values follow React's dangerousStyleValue.

import { renderFailureNoticeStyle, type SizingTokens } from "@kohaku-ui/renderer-core";

/** A teardown function that does nothing. */
export const noop = (): void => {};

/** Combines multiple teardowns into one. */
export function combineTeardowns(teardowns: (() => void)[]): () => void {
  return () => {
    // Release in reverse order (the inverse of build order). Avoids order dependencies in unsubscribe / detach.
    for (let i = teardowns.length - 1; i >= 0; i--) teardowns[i]!();
  };
}

/**
 * The set of properties that React's CSSProperty treats as "unitless numbers" and does not suffix with px.
 * Numbers not in this set (and not 0) get px appended; 0 is always "0" (no px).
 * With this mapping, visuallyHiddenStyle's width:1 → "1px", margin:-1 → "-1px", fontWeight:700 → "700", etc.
 * match React's output (a prerequisite for DOM semantic equivalence).
 */
const UNITLESS = new Set<string>([
  "animationIterationCount",
  "aspectRatio",
  "borderImageOutset",
  "borderImageSlice",
  "borderImageWidth",
  "boxFlex",
  "boxFlexGroup",
  "boxOrdinalGroup",
  "columnCount",
  "columns",
  "flex",
  "flexGrow",
  "flexPositive",
  "flexShrink",
  "flexNegative",
  "flexOrder",
  "gridArea",
  "gridRow",
  "gridRowEnd",
  "gridRowSpan",
  "gridRowStart",
  "gridColumn",
  "gridColumnEnd",
  "gridColumnSpan",
  "gridColumnStart",
  "fontWeight",
  "lineClamp",
  "lineHeight",
  "opacity",
  "order",
  "orphans",
  "tabSize",
  "widows",
  "zIndex",
  "zoom",
  "fillOpacity",
  "floodOpacity",
  "stopOpacity",
  "strokeDasharray",
  "strokeDashoffset",
  "strokeMiterlimit",
  "strokeOpacity",
  "strokeWidth",
]);

/** camelCase → kebab-case (CSS property name). */
function hyphenate(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Identical to React's dangerousStyleValue: null/boolean/"" is empty, non-unitless numbers other than 0 get px, 0 is "0". */
function styleValue(name: string, value: string | number): string {
  if (typeof value === "number" && value !== 0 && !UNITLESS.has(name)) {
    return `${value}px`;
  }
  return `${value}`.trim();
}

/**
 * Sets a style object onto element.style (equivalent to React's inline-style expansion).
 * Skips null / undefined values (consistent with React not emitting them as empty strings).
 */
export function setStyle(
  el: HTMLElement | SVGElement,
  style: Record<string, string | number | null | undefined>,
): void {
  for (const [name, value] of Object.entries(style)) {
    if (value == null || value === "") continue;
    el.style.setProperty(hyphenate(name), styleValue(name, value));
  }
}

/** Creates an HTML element and sets attributes (string/boolean). Attributes whose value is null/undefined/false are omitted. */
export function el(
  tag: string,
  attrs?: Record<string, string | number | boolean | null | undefined>,
  style?: Record<string, string | number | null | undefined>,
): HTMLElement {
  const node = document.createElement(tag);
  if (attrs != null) setAttrs(node, attrs);
  if (style != null) setStyle(node, style);
  return node;
}

/** Batch attribute setting. Boolean attributes are added with no value when true (consistent with React's boolean attributes). */
export function setAttrs(
  node: Element,
  attrs: Record<string, string | number | boolean | null | undefined>,
): void {
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(name, value === true ? "" : String(value));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Creates an SVG element (presentation attributes are given via setAttribute; consistent with React's SVG output). */
export function svgEl(
  tag: string,
  attrs?: Record<string, string | number | boolean | null | undefined>,
  style?: Record<string, string | number | null | undefined>,
): SVGElement {
  const node = document.createElementNS(SVG_NS, tag) as SVGElement;
  if (attrs != null) setAttrs(node, attrs);
  if (style != null) setStyle(node, style);
  return node;
}

/** Text node. Creates it even for the empty string (preserving Markdown's empty text segments keeps textContent matching). */
export function text(value: string): Text {
  return document.createTextNode(value);
}

/**
 * Generic placeholder for when a part cannot be rendered (unimplemented type / sandbox not injected / render failure).
 * Same markup as renderer-react's NodeNotice (SpecView.tsx).
 */
export function nodeNotice(message: string, color: string, sizing: SizingTokens): HTMLElement {
  const node = el("div", { role: "note" }, renderFailureNoticeStyle(color, sizing));
  node.appendChild(text(message));
  return node;
}
