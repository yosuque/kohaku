import { describe, expect, it } from "vitest";
import {
  ALLOWED_ATTRS,
  ALLOWED_STYLE_PROPS,
  ALLOWED_TAGS,
  containsJavascriptScheme,
  EXPLICITLY_DENIED_TAGS,
  isAttrAllowed,
  isAttrValueSafe,
  isStylePropAllowed,
  isStyleValueSafe,
  isTagAllowed,
  toKebabCase,
} from "../src/schema/sandbox-dom.js";
import { ATTR_VECTORS, STYLE_VALUE_VECTORS, TAG_VECTORS } from "./fixtures/sandbox-allowlist-vectors.js";

describe("sandbox DOM allowlist (shape)", () => {
  it("ALLOWED_TAGS is a non-empty lowercase set with no overlap with EXPLICITLY_DENIED_TAGS", () => {
    expect(ALLOWED_TAGS.size).toBeGreaterThan(30);
    for (const tag of ALLOWED_TAGS) {
      expect(tag).toBe(tag.toLowerCase());
      expect(EXPLICITLY_DENIED_TAGS.has(tag)).toBe(false);
    }
  });

  it("isTagAllowed rejects script/style/iframe/a/img/form and accepts common tags case-insensitively", () => {
    for (const tag of EXPLICITLY_DENIED_TAGS) {
      expect(isTagAllowed(tag)).toBe(false);
    }
    expect(isTagAllowed("div")).toBe(true);
    expect(isTagAllowed("DIV")).toBe(true);
    expect(isTagAllowed("svg")).toBe(true);
  });

  it("ALLOWED_ATTRS holds no on* / href / style entries", () => {
    for (const attr of ALLOWED_ATTRS) {
      expect(attr.startsWith("on")).toBe(false);
      expect(attr).not.toBe("href");
      expect(attr).not.toBe("style");
    }
  });

  it("isAttrAllowed always rejects on*, href, xlink:href, src, srcdoc, srcset, action, formaction, ping, target, download, is, style", () => {
    for (const name of [
      "onclick",
      "onerror",
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
    ]) {
      expect(isAttrAllowed(name)).toBe(false);
    }
  });

  it("isAttrAllowed accepts global / input / table / svg attributes and any aria-*/data-*", () => {
    expect(isAttrAllowed("id")).toBe(true);
    expect(isAttrAllowed("class")).toBe(true);
    expect(isAttrAllowed("value")).toBe(true);
    expect(isAttrAllowed("colspan")).toBe(true);
    expect(isAttrAllowed("viewbox")).toBe(true);
    expect(isAttrAllowed("aria-label")).toBe(true);
    expect(isAttrAllowed("data-anything")).toBe(true);
    expect(isAttrAllowed("unknown-attr")).toBe(false);
  });

  it("isAttrValueSafe rejects a javascript: scheme (any casing/spacing) and accepts ordinary values", () => {
    expect(isAttrValueSafe("javascript:alert(1)")).toBe(false);
    expect(isAttrValueSafe("JavaScript:alert(1)")).toBe(false);
    expect(isAttrValueSafe("javascript :alert(1)")).toBe(false);
    expect(isAttrValueSafe("plain value")).toBe(true);
    expect(containsJavascriptScheme("javascript:x")).toBe(true);
  });

  it("toKebabCase converts camelCase style property names", () => {
    expect(toKebabCase("backgroundColor")).toBe("background-color");
    expect(toKebabCase("color")).toBe("color");
  });

  it("isStylePropAllowed accepts ~80 common box/flex/grid/typography/color/border props and rejects unknowns", () => {
    expect(ALLOWED_STYLE_PROPS.size).toBeGreaterThan(60);
    expect(isStylePropAllowed("backgroundColor")).toBe(true);
    expect(isStylePropAllowed("background-color")).toBe(true);
    expect(isStylePropAllowed("display")).toBe(true);
    expect(isStylePropAllowed("flexDirection")).toBe(true);
    expect(isStylePropAllowed("behavior")).toBe(false);
    expect(isStylePropAllowed("cssText" as string)).toBe(false);
  });

  it("isStyleValueSafe allows url(#id) but rejects any other url(), expression(), and @import", () => {
    expect(isStyleValueSafe("url(#gradient1)")).toBe(true);
    expect(isStyleValueSafe("url('#gradient1')")).toBe(true);
    expect(isStyleValueSafe("url(https://evil.example/x.png)")).toBe(false);
    expect(isStyleValueSafe("url(data:image/png;base64,AAAA)")).toBe(false);
    expect(isStyleValueSafe("expression(alert(1))")).toBe(false);
    expect(isStyleValueSafe("@import url(evil.css)")).toBe(false);
    expect(isStyleValueSafe("10px solid red")).toBe(true);
  });
});

// H10: the same vector table (fixtures/sandbox-allowlist-vectors.ts) is also run, unmodified, through the
// real sandbox guest applier in packages/sandbox/test/guest/dom-applier.test.ts — see that file and the
// fixture's own module docstring. A drift between the two allow-lists fails a row on one side or the other.
describe("sandbox DOM allowlist (shared vectors, spec-core side)", () => {
  it.each(TAG_VECTORS)("isTagAllowed($tag) === $specCore", ({ tag, specCore }) => {
    expect(isTagAllowed(tag)).toBe(specCore);
  });

  it.each(ATTR_VECTORS)(
    "isAttrAllowed($name) === $attrAllowed, isAttrValueSafe($value) === $valueSafe",
    ({ name, value, attrAllowed, valueSafe }) => {
      expect(isAttrAllowed(name)).toBe(attrAllowed);
      expect(isAttrValueSafe(value)).toBe(valueSafe);
    },
  );

  it.each(STYLE_VALUE_VECTORS)(
    "isStyleValueSafe($value) === $safe (prop $prop is itself allowed)",
    ({ prop, value, safe }) => {
      // Sanity: the prop held constant per row is itself allowed, so the vector isolates value safety.
      expect(isStylePropAllowed(prop)).toBe(true);
      expect(isStyleValueSafe(value)).toBe(safe);
    },
  );
});
