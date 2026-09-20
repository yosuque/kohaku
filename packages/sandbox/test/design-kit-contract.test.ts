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
