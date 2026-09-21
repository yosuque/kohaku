import type { KnownThemeTokens } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  defaultDarkTheme,
  defaultLightTheme,
  HOST_STYLE_VARIABLE_MAP,
  resolveSizing,
  resolveToken,
  sandboxThemeCss,
  themeFromHostStyles,
  themeTokensToCssVars,
} from "../src/index.js";

describe("resolveToken", () => {
  it("returns the value when the token exists, otherwise the fallback (3-argument, backward compatible)", () => {
    expect(resolveToken({ "color.muted": "#111" }, "color.muted", "#000")).toBe("#111");
    expect(resolveToken({}, "color.muted", "#6b7280")).toBe("#6b7280");
  });

  it("an explicit fallback (3-argument) takes priority over the default theme net (preserving old API semantics)", () => {
    // if a fallback different from the default is passed, the explicit fallback is returned instead of the default #4f46e5.
    expect(resolveToken({}, "color.primary", "red")).toBe("red");
    // meanwhile, the 2-argument form (fallback omitted) falls through to the default light theme net.
    expect(resolveToken({}, "color.primary")).toBe("#4f46e5");
    // if a theme is specified, the theme takes priority over the explicit fallback (order: theme → alias → fallback → default net).
    expect(resolveToken({ "color.primary": "#abcdef" }, "color.primary", "red")).toBe("#abcdef");
  });

  it("preserves numeric tokens too", () => {
    expect(resolveToken({ "space.sm": 4 }, "space.sm", 8)).toBe(4);
  });

  it("2-argument form: falls through to the default light theme net even without a fallback", () => {
    expect(resolveToken({}, "color.muted")).toBe(defaultLightTheme["color.muted"]);
    expect(resolveToken({}, "color.primary")).toBe("#4f46e5");
    expect(resolveToken({}, "color.negative.surface")).toBe("#fee2e2");
  });

  it("theme[name] takes priority over the default theme and fallback (0 / empty string are respected as specified values too)", () => {
    expect(resolveToken({ "color.primary": "#abcdef" }, "color.primary")).toBe("#abcdef");
    // an empty string is also respected as a "specified value" and does not fall through to the default net (a known token, so 2 arguments).
    expect(resolveToken({ "color.primary": "" }, "color.primary")).toBe("");
    // the retention of numeric 0 is verified via the 3-argument (arbitrary token) path (theme value 0 beats fallback 8).
    expect(resolveToken({ "space.sm": 0 }, "space.sm", 8)).toBe(0);
  });

  it("alias: color.danger resolves to color.negative, color.focus to color.primary", () => {
    expect(resolveToken({}, "color.danger")).toBe(resolveToken({}, "color.negative"));
    expect(resolveToken({}, "color.focus")).toBe(resolveToken({}, "color.primary"));
  });

  it("aliases follow the overridden target token (since they have no entity in the default theme)", () => {
    const theme = { ...defaultLightTheme, "color.negative": "#0000ff", "color.primary": "#00ff00" };
    expect(resolveToken(theme, "color.danger")).toBe("#0000ff");
    expect(resolveToken(theme, "color.focus")).toBe("#00ff00");
  });

  it("explicitly specifying the alias itself takes priority", () => {
    expect(resolveToken({ "color.danger": "#123456" }, "color.danger")).toBe("#123456");
  });
});

describe("default theme", () => {
  it("light / dark have the same key set (no missing keys in dark)", () => {
    expect(Object.keys(defaultDarkTheme).sort()).toEqual(Object.keys(defaultLightTheme).sort());
  });

  it("aliases (color.danger / color.focus) have no entity in the default theme", () => {
    expect("color.danger" in defaultLightTheme).toBe(false);
    expect("color.focus" in defaultLightTheme).toBe(false);
  });

  it("color.scrim (the dialog backdrop) has its own concrete light/dark value, unlike the deprecated aliases", () => {
    expect(defaultLightTheme["color.scrim"]).toBe("rgba(17, 24, 39, 0.45)");
    expect(defaultDarkTheme["color.scrim"]).toBe("rgba(0, 0, 0, 0.6)");
    expect(defaultDarkTheme["color.scrim"]).not.toBe(defaultLightTheme["color.scrim"]);
  });

  it("resolves with dark values when the dark theme is passed", () => {
    expect(resolveToken(defaultDarkTheme, "color.background")).toBe("#0f1115");
    expect(resolveToken(defaultDarkTheme, "color.text")).toBe("#e6e8ee");
  });

  it("non-color tokens (v2) are defined in both themes, and only shadow.* differs between light and dark", () => {
    const nonColorKeys = [
      "font.family.sans",
      "font.family.mono",
      "font.size.xs",
      "font.size.sm",
      "font.size.md",
      "font.size.lg",
      "font.size.xl",
      "font.size.2xl",
      "space.1",
      "space.2",
      "space.3",
      "space.4",
      "space.5",
      "space.6",
      "radius.sm",
      "radius.md",
      "radius.lg",
      "radius.full",
      "shadow.sm",
      "shadow.md",
      "motion.duration",
      "motion.easing",
    ] as const;
    for (const key of nonColorKeys) {
      expect(typeof defaultLightTheme[key]).toBe("string");
      expect(typeof defaultDarkTheme[key]).toBe("string");
      if (!key.startsWith("shadow.")) expect(defaultDarkTheme[key]).toBe(defaultLightTheme[key]);
    }
    expect(defaultDarkTheme["shadow.sm"]).not.toBe(defaultLightTheme["shadow.sm"]);
    expect(defaultLightTheme["font.size.md"]).toBe("13.5px");
    expect(defaultLightTheme["space.4"]).toBe("16px");
    expect(defaultLightTheme["radius.md"]).toBe("8px");
  });

  it("every default token converts to a CSS custom property name and survives sandboxThemeCss sanitization", () => {
    const css = sandboxThemeCss(defaultLightTheme);
    expect(css).toContain("--kohaku-font-family-sans:system-ui");
    expect(css).toContain("--kohaku-font-size-2xl:28px;");
    expect(css).toContain("--kohaku-radius-full:9999px;");
    expect(css).toContain("--kohaku-motion-easing:cubic-bezier(.2,0,0,1);");
    expect(css).toContain("--kohaku-shadow-sm:0 1px 2px rgb(0 0 0 / .06);");
  });
});

// WCAG relative luminance and contrast ratio (a local implementation to machine-verify the dark theme's AA).
function relLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((x) => x + x)
          .join("")
      : h;
  const chan = (i: number): number => {
    const s = parseInt(full.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}
function contrast(fg: string, bg: string): number {
  const [hi, lo] = [relLuminance(fg), relLuminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
const T = (k: string): string => String(defaultDarkTheme[k as keyof typeof defaultDarkTheme]);

describe("dark theme WCAG AA contrast (measured)", () => {
  it("body/auxiliary text is ≥ 4.5:1 on background and surface", () => {
    for (const bg of [T("color.background"), T("color.surface")]) {
      expect(contrast(T("color.text"), bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(T("color.muted"), bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("on-primary (white) on fills is ≥ 4.5:1 on primary / negative (danger) fills", () => {
    // #6366f1 falls slightly short at 4.47 → #5b5ef0; #f87171 at 2.77 → adjusted to #dc2626.
    expect(contrast(T("color.on-primary"), T("color.primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(T("color.on-primary"), T("color.negative"))).toBeGreaterThanOrEqual(4.5);
  });

  it("a tone's text is ≥ 4.5:1 on the same tone's surface", () => {
    expect(contrast(T("color.positive.text"), T("color.positive.surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(T("color.negative.text"), T("color.negative.surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(T("color.warning.text"), T("color.warning.surface"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(T("color.info.text"), T("color.info.surface"))).toBeGreaterThanOrEqual(4.5);
  });

  it("solid (delta) and axis lines are ≥ 3:1 on dark backgrounds (UI/large; direction is redundantly encoded with symbols)", () => {
    for (const bg of [T("color.background"), T("color.surface")]) {
      expect(contrast(T("color.positive"), bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(T("color.negative"), bg)).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(T("chart.axis"), T("color.background"))).toBeGreaterThanOrEqual(3);
  });

  it("the dark chart palette (7 colors) is ≥ 3:1 for all colors on dark backgrounds", () => {
    for (const c of T("chart.palette").split(",")) {
      expect(contrast(c, T("color.background"))).toBeGreaterThanOrEqual(3);
    }
  });
});

// A representative set of MCP-standard host style variables, sourced from
// defaultLightTheme's own (already dark-text-on-light-background) values, so overlaying
// them onto defaultDarkTheme is also a stress test: a dark background base gets a light
// background from the host (case="an inconsistent host+base combination").
const HOST_LIGHT_STYLE_VARIABLES: Record<string, string> = {
  "--color-background-primary": String(defaultLightTheme["color.background"]),
  "--color-background-secondary": String(defaultLightTheme["color.surface"]),
  "--color-text-primary": String(defaultLightTheme["color.text"]),
  "--color-text-secondary": String(defaultLightTheme["color.muted"]),
  "--color-border-primary": String(defaultLightTheme["color.border"]),
  "--color-background-danger": String(defaultLightTheme["color.negative.surface"]),
  "--color-text-danger": String(defaultLightTheme["color.negative.text"]),
  "--color-border-danger": String(defaultLightTheme["color.negative.border"]),
  "--color-background-success": String(defaultLightTheme["color.positive.surface"]),
  "--color-text-success": String(defaultLightTheme["color.positive.text"]),
  "--color-border-success": String(defaultLightTheme["color.positive.border"]),
  "--color-background-warning": String(defaultLightTheme["color.warning.surface"]),
  "--color-text-warning": String(defaultLightTheme["color.warning.text"]),
  "--color-background-info": String(defaultLightTheme["color.info.surface"]),
  "--color-text-info": String(defaultLightTheme["color.info.text"]),
  "--color-border-info": String(defaultLightTheme["color.info.border"]),
};

describe("host-overlaid theme WCAG AA contrast (measured): does removing the -inverse mapping (item 1) keep the fill+foreground pairing intact under a host overlay?", () => {
  const overlaidOnLight = themeFromHostStyles(HOST_LIGHT_STYLE_VARIABLES, defaultLightTheme);
  const overlaidOnDark = themeFromHostStyles(HOST_LIGHT_STYLE_VARIABLES, defaultDarkTheme);
  const V = (theme: ReturnType<typeof themeFromHostStyles>, k: string): string =>
    String(theme[k as keyof typeof theme]);

  it("body/auxiliary text remains ≥ 4.5:1 on background and surface after the overlay, on both bases", () => {
    for (const overlaid of [overlaidOnLight, overlaidOnDark]) {
      for (const bg of [V(overlaid, "color.background"), V(overlaid, "color.surface")]) {
        expect(contrast(V(overlaid, "color.text"), bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(V(overlaid, "color.muted"), bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("color.on-primary vs color.primary remains ≥ 4.5:1 on both bases (neither token is in HOST_STYLE_VARIABLE_MAP, so the overlay never touches this fill+foreground pair)", () => {
    for (const overlaid of [overlaidOnLight, overlaidOnDark]) {
      expect(contrast(V(overlaid, "color.on-primary"), V(overlaid, "color.primary"))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("solid UI indicator colors and chart.axis remain ≥ 3:1 against a self-consistent overlay (light host variables over the light base)", () => {
    for (const bg of [V(overlaidOnLight, "color.background"), V(overlaidOnLight, "color.surface")]) {
      expect(contrast(V(overlaidOnLight, "color.positive"), bg)).toBeGreaterThanOrEqual(3);
      expect(contrast(V(overlaidOnLight, "color.negative"), bg)).toBeGreaterThanOrEqual(3);
    }
    expect(
      contrast(V(overlaidOnLight, "chart.axis"), V(overlaidOnLight, "color.background")),
    ).toBeGreaterThanOrEqual(3);
  });

  // NOT asserted, reported instead (per this work package's instructions: report a threshold
  // that cannot legitimately hold rather than weakening it): `color.positive` / `color.negative`
  // (solid) and `chart.axis` are not in HOST_STYLE_VARIABLE_MAP, so a host overlay never
  // touches them — they always keep the *base*'s own value. That is fine as long as the base
  // an integration picks actually matches the host's mode (light host variables paired with
  // `defaultLightTheme`, dark with `defaultDarkTheme`, per `hostContext.theme`), which is what
  // `resolveHostTheme` + the sample host integration do. But `themeFromHostStyles` itself has no
  // way to detect a mismatched pairing (e.g. a host sending light-toned background/text
  // variables while `defaultDarkTheme` is still passed as `base`): on `overlaidOnDark` here,
  // `defaultDarkTheme`'s own `color.positive` (#4ade80, tuned for a dark background) measures
  // only ~1.7:1 against the overlaid (light) `color.background`, and `chart.axis` (#9aa1ad)
  // only ~2.6:1 — both well under the 3:1 UI-element threshold. This is not a regression from
  // removing the `-inverse` mapping (item 1); those tokens were never mapped and this
  // mismatched-pairing gap pre-dates this change.

  it("(documents the gap above) defaultDarkTheme's own solid indicator colors do fall under 3:1 once the base is mismatched against an overlaid light background", () => {
    expect(contrast(V(overlaidOnDark, "color.positive"), V(overlaidOnDark, "color.background"))).toBeLessThan(
      3,
    );
    expect(contrast(V(overlaidOnDark, "chart.axis"), V(overlaidOnDark, "color.background"))).toBeLessThan(3);
  });
});

describe("themeFromHostStyles (MCP host-theme adoption via hostContext.styles.variables)", () => {
  it("maps recognized standard host variables onto their kohaku token, overlaying base", () => {
    const theme = themeFromHostStyles(
      {
        "--color-background-primary": "#010101",
        "--color-text-primary": "#020202",
        "--color-border-primary": "#030303",
      },
      defaultLightTheme,
    );
    expect(theme["color.background"]).toBe("#010101");
    expect(theme["color.text"]).toBe("#020202");
    expect(theme["color.border"]).toBe("#030303");
    // Unspecified known tokens keep the base's value (fall through, not dropped).
    expect(theme["color.surface"]).toBe(defaultLightTheme["color.surface"]);
    expect(theme["color.primary"]).toBe(defaultLightTheme["color.primary"]);
  });

  // Explicit expected map (host variable -> token), independent of HOST_STYLE_VARIABLE_MAP's own
  // literal, so that deleting an entry or mis-mapping one makes this test fail (a plain
  // keys()/values() round-trip through the map itself would still pass either way).
  const EXPECTED_HOST_STYLE_VARIABLE_MAP: Record<string, keyof KnownThemeTokens> = {
    "--color-background-primary": "color.background",
    "--color-background-secondary": "color.surface",
    "--color-text-primary": "color.text",
    "--color-text-secondary": "color.muted",
    "--color-border-primary": "color.border",
    "--color-background-danger": "color.negative.surface",
    "--color-text-danger": "color.negative.text",
    "--color-border-danger": "color.negative.border",
    "--color-background-success": "color.positive.surface",
    "--color-text-success": "color.positive.text",
    "--color-border-success": "color.positive.border",
    "--color-background-warning": "color.warning.surface",
    "--color-text-warning": "color.warning.text",
    "--color-background-info": "color.info.surface",
    "--color-text-info": "color.info.text",
    "--color-border-info": "color.info.border",
  };

  it("HOST_STYLE_VARIABLE_MAP matches the expected host-variable -> token mapping exactly", () => {
    expect(HOST_STYLE_VARIABLE_MAP).toEqual(EXPECTED_HOST_STYLE_VARIABLE_MAP);
  });

  it("does not map the host's -inverse family (no kohaku 'inverted surface' concept to pair it with)", () => {
    expect(HOST_STYLE_VARIABLE_MAP).not.toHaveProperty("--color-text-inverse");
    expect(HOST_STYLE_VARIABLE_MAP).not.toHaveProperty("--color-background-inverse");
    expect(HOST_STYLE_VARIABLE_MAP).not.toHaveProperty("--color-border-inverse");
  });

  it("applies every entry declared in HOST_STYLE_VARIABLE_MAP", () => {
    const variables: Record<string, string> = {};
    for (const hostVar of Object.keys(HOST_STYLE_VARIABLE_MAP)) variables[hostVar] = "#abcdef";
    const theme = themeFromHostStyles(variables, defaultLightTheme);
    for (const tokenName of Object.values(HOST_STYLE_VARIABLE_MAP)) {
      expect(theme[tokenName]).toBe("#abcdef");
    }
  });

  it("an unknown host variable name is ignored (base is kept, no exception)", () => {
    const theme = themeFromHostStyles({ "--color-accent-unknown": "#ff0000" }, defaultLightTheme);
    expect(theme).toEqual(defaultLightTheme);
  });

  it("an empty-string value falls back to base instead of clobbering the token", () => {
    const theme = themeFromHostStyles({ "--color-background-primary": "" }, defaultLightTheme);
    expect(theme["color.background"]).toBe(defaultLightTheme["color.background"]);
  });

  it("a whitespace-only value is skipped and base's value is kept", () => {
    const theme = themeFromHostStyles({ "--color-background-primary": "   " }, defaultLightTheme);
    expect(theme["color.background"]).toBe(defaultLightTheme["color.background"]);
  });

  it("an optional custom map is honoured in place of HOST_STYLE_VARIABLE_MAP", () => {
    const customMap: Readonly<Record<string, keyof KnownThemeTokens>> = {
      "--acme-brand-accent": "color.primary",
    };
    const theme = themeFromHostStyles(
      { "--acme-brand-accent": "#123abc", "--color-background-primary": "#ffffff" },
      defaultLightTheme,
      customMap,
    );
    // Mapped via the custom map.
    expect(theme["color.primary"]).toBe("#123abc");
    // Not in the custom map, so the default HOST_STYLE_VARIABLE_MAP entry is NOT consulted:
    // base's value is kept even though the variable name is otherwise recognized by the default map.
    expect(theme["color.background"]).toBe(defaultLightTheme["color.background"]);
  });

  it("an undefined value (as McpUiStyles allows) is skipped without throwing", () => {
    const theme = themeFromHostStyles({ "--color-background-primary": undefined }, defaultLightTheme);
    expect(theme["color.background"]).toBe(defaultLightTheme["color.background"]);
  });

  it("an empty variables map returns base unchanged", () => {
    expect(themeFromHostStyles({}, defaultLightTheme)).toEqual(defaultLightTheme);
  });

  it("works against defaultDarkTheme as base too (dark-mode host)", () => {
    const theme = themeFromHostStyles({ "--color-background-primary": "#111111" }, defaultDarkTheme);
    expect(theme["color.background"]).toBe("#111111");
    expect(theme["color.text"]).toBe(defaultDarkTheme["color.text"]);
  });

  it("does not mutate the base object passed in", () => {
    const base = { ...defaultLightTheme };
    themeFromHostStyles({ "--color-background-primary": "#123456" }, base);
    expect(base).toEqual(defaultLightTheme);
  });
});

describe("themeTokensToCssVars", () => {
  it("replaces . with - in token names and adds the --kohaku- prefix; values are stringified", () => {
    expect(themeTokensToCssVars({ "color.primary": "#4f46e5", "space.sm": 4 })).toEqual({
      "--kohaku-color-primary": "#4f46e5",
      "--kohaku-space-sm": "4",
    });
  });

  it("empty theme is an empty map", () => {
    expect(themeTokensToCssVars({})).toEqual({});
  });
});

describe("sandboxThemeCss (token-injection CSS for the L2 sandbox)", () => {
  it("all default light theme tokens are defined on :root even when theme is unspecified", () => {
    const css = sandboxThemeCss();
    expect(css.startsWith(":root{")).toBe(true);
    expect(css.endsWith("}")).toBe(true);
    for (const name of Object.keys(defaultLightTheme)) {
      expect(css).toContain(`--kohaku-${name.replace(/\./g, "-")}:`);
    }
    expect(css).toContain("--kohaku-color-primary:#4f46e5;");
  });

  it("a partial theme is merged into the default light theme (override + filling missing keys)", () => {
    const css = sandboxThemeCss({ "color.primary": "#123456" });
    expect(css).toContain("--kohaku-color-primary:#123456;");
    // a missing key is always defined with the default light theme's value (preventing a var() undefined fall-through)
    expect(css).toContain(`--kohaku-color-background:${defaultLightTheme["color.background"]};`);
  });

  it("decomposes chart.palette (CSV) into --kohaku-chart-palette-N (1-based)", () => {
    const css = sandboxThemeCss();
    const palette = defaultLightTheme["chart.palette"].split(",");
    palette.forEach((color, i) => {
      expect(css).toContain(`--kohaku-chart-palette-${i + 1}:${color};`);
    });
  });

  it("fills up to 7 by cycling even when the palette has fewer than 7 colors (paired with the prompt's 1-7 guidance)", () => {
    const css = sandboxThemeCss({ "chart.palette": "#111111,#222222" });
    expect(css).toContain("--kohaku-chart-palette-1:#111111;");
    expect(css).toContain("--kohaku-chart-palette-2:#222222;");
    expect(css).toContain("--kohaku-chart-palette-3:#111111;");
    expect(css).toContain("--kohaku-chart-palette-7:#111111;");
  });

  it("custom tokens (open index signature) are injected too", () => {
    expect(sandboxThemeCss({ "brand.accent": "#ff8800" })).toContain("--kohaku-brand-accent:#ff8800;");
  });

  it("characters that would break the CSS declaration are sanitized (invalid variable names excluded; <>{}; stripped from values)", () => {
    const css = sandboxThemeCss({
      "bad name": "#111111",
      "brand.evil": "red;}</style><script>alert(1)</script>",
    });
    expect(css).not.toContain("bad name");
    expect(css).not.toContain("</style>");
    expect(css).not.toContain("<script>");
    expect(css).toContain("--kohaku-brand-evil:red/stylescriptalert(1)/script;");
  });

  it("injects dark values when the dark theme is passed", () => {
    const css = sandboxThemeCss(defaultDarkTheme);
    expect(css).toContain("--kohaku-color-background:#0f1115;");
    expect(css).toContain("--kohaku-color-text:#e6e8ee;");
  });
});

describe("resolveSizing", () => {
  it("resolves the non-color tokens into a flat bag (default light net when unspecified)", () => {
    const s = resolveSizing({});
    expect(s.fontSans).toBe(defaultLightTheme["font.family.sans"]);
    expect(s.fontMd).toBe("13.5px");
    expect(s.space2).toBe("8px");
    expect(s.radiusLg).toBe("12px");
    expect(s.shadowSm).toBe(defaultLightTheme["shadow.sm"]);
    expect(s.motionDuration).toBe("150ms");
  });

  it("follows theme overrides", () => {
    const s = resolveSizing({ "radius.md": "2px", "font.size.md": "14px" });
    expect(s.radiusMd).toBe("2px");
    expect(s.fontMd).toBe("14px");
  });
});
