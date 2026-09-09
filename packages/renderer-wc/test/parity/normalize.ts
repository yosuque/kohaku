// DOM → semantic-JSON normalizer (the heart of the main check "semantic DOM equivalence").
//
// Both renderers (React / WC) consume the same renderer-core pure functions, so the divergence surface is
// reduced to markup assembly. Here we fold the real DOM down to "meaning only" to make it comparable:
//   - Preserve tag / role / aria-* / data-* / other semantic attributes
//   - Handle the incidental differences in class (React does not add one; WC only on the root) and style strings separately
//   - style is enumerated from el.style into a sorted map (both pass through the same jsdom CSSOM, so mechanism differences cancel out)
//   - textContent "joins consecutive text and drops empty strings" — absorbing the difference between React's empty text
//     segments and WC's empty text nodes (handoff ⑤) to the extent it does not affect meaning
//   - Comment nodes (WC's visibleWhen / bound anchors) are ignored
//
// React-specific internal attributes do not remain in the DOM (they live on the fiber), so once class and style are removed, the remaining attributes are semantic only.

/** A normalized node (element). */
export interface SemanticNode {
  tag: string;
  /** All attributes except class / style, in ascending name order. */
  attrs: Record<string, string>;
  /** Inline style enumerated from el.style (property names are kebab, values are post-jsdom-normalization). */
  style: Record<string, string>;
  children: SemanticChild[];
}

/** A child is either an element or text (joined, non-empty). */
export type SemanticChild = SemanticNode | { text: string };

/** class and style are handled separately, so drop them from the attribute map. value/checked are matched via properties, so drop them from the attributes. */
const SKIP_ATTRS = new Set(["class", "style", "value", "checked"]);

/** For form controls, the "actually displayed value" lives on the property side (React=controlled does not emit the attribute;
 *  WC=semi-uncontrolled does emit it — handoff ③). The attribute difference is incidental, so match via the .value / .checked properties. */
const FORM_CONTROLS = new Set(["input", "select", "textarea"]);

function attrsOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const names = [...el.attributes].map((a) => a.name).filter((n) => !SKIP_ATTRS.has(n));
  names.sort();
  for (const name of names) out[name] = el.getAttribute(name) ?? "";
  const tag = el.tagName.toLowerCase();
  if (FORM_CONTROLS.has(tag)) {
    out["value"] = String((el as HTMLInputElement).value ?? "");
    if (tag === "input") {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox" || type === "radio") out["checked"] = String((el as HTMLInputElement).checked);
    }
  }
  return out;
}

function styleOf(el: Element): Record<string, string> {
  const style = (el as HTMLElement).style;
  const out: Record<string, string> = {};
  if (style == null) return out;
  const names: string[] = [];
  for (let i = 0; i < style.length; i++) names.push(style[i]!);
  names.sort();
  for (const name of names) out[name] = style.getPropertyValue(name);
  return out;
}

/** Folds a single element into a semantic node. Children are elements and text (joined, empties dropped, comments ignored). */
export function normalize(el: Element): SemanticNode {
  const children: SemanticChild[] = [];
  let textBuf = "";
  const flush = (): void => {
    if (textBuf !== "") children.push({ text: textBuf });
    textBuf = "";
  };
  for (const child of el.childNodes) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      textBuf += child.textContent ?? "";
    } else if (child.nodeType === 1 /* ELEMENT_NODE */) {
      flush();
      children.push(normalize(child as Element));
    }
    // Comment nodes (WC's anchors) and the like are ignored.
  }
  flush();
  return { tag: el.tagName.toLowerCase(), attrs: attrsOf(el), style: styleOf(el), children };
}

/** Normalizes a parent element's child elements in order (used to compare subtrees under the surface — absorbing the one-shadow-layer difference of handoff ④). */
export function normalizeChildren(parent: Element): SemanticNode[] {
  return [...parent.children].map((c) => normalize(c));
}
