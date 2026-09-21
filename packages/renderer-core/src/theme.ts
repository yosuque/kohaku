import type { KnownThemeTokens, ThemeTokens } from "@kohaku-ui/spec-core";
import { DEFAULT_CHART_PALETTE } from "./presenters/chart.js";

/**
 * The default theme for the semantic design tokens. The single home of the
 * values.
 *
 * Part code holds no fallback literals and calls only `resolveToken(theme, name)`.
 * Keys the theme did not specify fall through to this default-theme net (because
 * both renderers pull the same net, resolved values match mechanically → parity
 * guaranteed). spec-core is environment-neutral so it cannot hold values; the
 * values are owned by renderer-core (the type KnownThemeTokens lives in spec-core).
 *
 * The aliases (color.danger / color.focus) have no concrete entry in the default
 * theme — this prevents the accident where an alias can no longer follow its
 * override target once an app spreads the default theme and overrides the target
 * tokens (negative / primary).
 */
type ThemeDefaults = Required<Omit<KnownThemeTokens, "color.danger" | "color.focus">>;

/**
 * Non-color token defaults shared verbatim by light and dark (only shadow.* differs per theme). The
 * values are CSS strings with units so both renderers inline the identical text (parity by construction).
 * The font sizes match the px values the L1 parts used before tokenization (13.5 body, 12.5 captions,
 * 28 KPI values) — but adopting these tokens does deliberately shift the existing look in a few places
 * that had no equivalent literal before: the metric (KPI) now renders as a card, tables gained a muted
 * 1px header divider, and `shadow.md` (dialogs/toasts) was raised to a stronger elevation. See
 * `.changeset/l1-parts-tokens.md` for the full list of visual changes this release carries.
 */
const NON_COLOR_DEFAULTS = {
  "font.family.sans":
    'system-ui, -apple-system, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", sans-serif',
  "font.family.mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  "font.size.xs": "11px",
  "font.size.sm": "12.5px",
  "font.size.md": "13.5px",
  "font.size.lg": "15px",
  "font.size.xl": "20px",
  "font.size.2xl": "28px",
  "space.1": "4px",
  "space.2": "8px",
  "space.3": "12px",
  "space.4": "16px",
  "space.5": "24px",
  "space.6": "32px",
  "radius.sm": "4px",
  "radius.md": "8px",
  "radius.lg": "12px",
  "radius.full": "9999px",
  "motion.duration": "150ms",
  "motion.easing": "cubic-bezier(.2,0,0,1)",
} as const;

/** The default light theme (the light values preserve the original hard-coded look). */
export const defaultLightTheme: ThemeDefaults = {
  "color.background": "#ffffff",
  "color.surface": "#f8fafc",
  "color.border": "#e5e7eb",
  "color.text": "#1a1a2e",
  "color.muted": "#6b7280",
  "color.on-primary": "#ffffff",
  "color.primary": "#4f46e5",
  "color.positive": "#16a34a",
  "color.positive.surface": "#f0fdf4",
  "color.positive.text": "#166534",
  "color.positive.border": "#bbf7d0",
  "color.negative": "#dc2626",
  "color.negative.surface": "#fee2e2",
  "color.negative.text": "#991b1b",
  "color.negative.border": "#fecaca",
  "color.warning.surface": "#fef9c3",
  "color.warning.text": "#854d0e",
  "color.info.surface": "#eff6ff",
  "color.info.text": "#1e40af",
  "color.info.border": "#bfdbfe",
  "chart.axis": "#374151",
  "chart.palette": DEFAULT_CHART_PALETTE.join(","),
  ...NON_COLOR_DEFAULTS,
  "shadow.sm": "0 1px 2px rgb(0 0 0 / .06)",
  "shadow.md": "0 8px 32px rgb(0 0 0 / .18)",
};

/**
 * The default dark theme. Values that empirically satisfy WCAG AA — body text
 * ≥ 4.5:1 / UI and large text ≥ 3:1 (all pairs contrast-measured, see below). The fill
 * lightness of primary/negative is chosen so on-primary works while staying white
 * in both modes (avoiding a theme-dependent inversion).
 *
 * Key points from measurement (fg on bg → ratio):
 * - on-primary (#fff) is ≥4.5 on both fills: primary #5b5ef0 (4.88:1) / negative
 *   #dc2626 (danger fill, 4.83:1). #6366f1 fell slightly short at 4.47:1 with white
 *   text, so it was adjusted to #5b5ef0; #f87171 was 2.77:1 with white text, so it
 *   was adjusted to #dc2626.
 * - negative must satisfy, with a single token, the conflicting requirements of a
 *   "danger fill carrying white text (≥4.5)" and "delta / required-mark text on a
 *   dark background (≥3)" (the alias-table colors are assumed to have no concrete
 *   entry). Prioritizing white text ≥4.5, we take #dc2626 and reconcile it on a
 *   dark background at 3.91:1 (≥3, equivalent to UI/large; direction is made
 *   redundant with ▲▼ and the sign).
 * - The border family are decorative separators (even the default light is
 *   1.18–1.31:1) and do not hit the 1.4.11 essential-boundary requirement, so 3:1
 *   is not imposed. For structural visibility on a dark background, they are only
 *   lifted slightly from #2c313c → #333a47.
 *
 * So a missing key does not fall through to light and break dark, apps use it as
 * `{ ...defaultDarkTheme, ...brand }`.
 */
export const defaultDarkTheme: ThemeDefaults = {
  "color.background": "#0f1115",
  "color.surface": "#1a1d24",
  "color.border": "#333a47",
  "color.text": "#e6e8ee",
  "color.muted": "#9aa1ad",
  "color.on-primary": "#ffffff",
  "color.primary": "#5b5ef0",
  "color.positive": "#4ade80",
  "color.positive.surface": "#14311f",
  "color.positive.text": "#4ade80",
  "color.positive.border": "#1f5133",
  "color.negative": "#dc2626",
  "color.negative.surface": "#3b1d1d",
  "color.negative.text": "#fca5a5",
  "color.negative.border": "#5b2626",
  "color.warning.surface": "#3a2f14",
  "color.warning.text": "#fcd34d",
  "color.info.surface": "#172a3f",
  "color.info.text": "#93c5fd",
  "color.info.border": "#2b4a6b",
  "chart.axis": "#9aa1ad",
  "chart.palette": "#818cf8,#38bdf8,#34d399,#fbbf24,#f87171,#a78bfa,#2dd4bf",
  ...NON_COLOR_DEFAULTS,
  "shadow.sm": "0 1px 2px rgb(0 0 0 / .5)",
  "shadow.md": "0 8px 32px rgb(0 0 0 / .6)",
};

/**
 * Token aliases (deprecated old names → resolution to the current token). Work only
 * when the theme does not have that key. They re-resolve the target token via
 * resolveToken, so they follow along if the app overrides the target (negative /
 * primary).
 */
const DEFAULT_TOKEN_ALIASES: Record<string, (theme: ThemeTokens) => string | number> = {
  "color.danger": (theme) => resolveToken(theme, "color.negative"),
  "color.focus": (theme) => resolveToken(theme, "color.primary"),
};

/**
 * Theme token reference (the pure-function version of useToken / tokenStr; the Spec
 * is theme-independent — SPEC-ENV-003).
 *
 * Resolution order: `theme[name]` (app-specified) → alias table → **explicit
 * fallback (3rd argument)** → defaultLightTheme (the default net). The explicit
 * fallback is placed before the default net to preserve the old API's semantics
 * (respect a fallback that differs from the default) — e.g.
 * `resolveToken({}, "color.primary", "red")` returns "red", not the default
 * #4f46e5. Parts hold no literal fallback and call with 2 arguments (the values are
 * consolidated in defaultLightTheme). The 3-argument version is kept for the
 * gradual migration.
 *
 * Types: the 2-argument version takes `name: keyof KnownThemeTokens` (known tokens,
 * including aliases; no fallback needed because it always resolves via the Required
 * default light theme net or the alias table); arbitrary string tokens are allowed
 * only via the 3-argument version that requires a fallback (closing the undefined
 * leak on the 2-argument path at the type level).
 *
 * React's useToken expands the return value into inline styles as a JS value, and
 * renderer-wc resolves via the same resolveToken and sets the same value onto
 * element.style. Because both renderers pull the same default net, resolved values
 * match even without a specified theme (the pixel-match mechanism = "inline
 * resolved tokens").
 */
export function resolveToken(theme: ThemeTokens, name: keyof KnownThemeTokens): string | number;
export function resolveToken(theme: ThemeTokens, name: string, fallback: string | number): string | number;
export function resolveToken(theme: ThemeTokens, name: string, fallback?: string | number): string | number {
  const resolved = theme[name] ?? DEFAULT_TOKEN_ALIASES[name]?.(theme);
  if (resolved != null) return resolved;
  // The explicit fallback (3rd argument) takes priority over the default-theme net
  // (respect a fallback that differs from the default = old API semantics). The
  // 2-argument path that omits the fallback (fallback == null) falls through to the
  // default light theme net.
  if (fallback != null) return fallback;
  // For the 2-argument form, name is keyof KnownThemeTokens. It always resolves via the Required default light theme net (aliases were resolved above).
  return (defaultLightTheme as ThemeTokens)[name];
}

/**
 * Converts ThemeTokens into a map of CSS custom properties (renderer-wc's `:host`
 * extension point). Replaces `.` with `-` and adds a prefix, e.g. token name
 * `color.muted` → `--kohaku-color-muted`. Values are `String(value)` (numbers are
 * stringified too).
 *
 * This is not the pixel-match mechanism but a bonus that enables theme overrides
 * from external CSS (the core of parity is the inline expansion via resolveToken).
 * renderer-wc applies it to `:host`.
 */
export function themeTokensToCssVars(theme: ThemeTokens): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(theme)) {
    vars[`--kohaku-${name.replace(/\./g, "-")}`] = String(value);
  }
  return vars;
}

/**
 * Maps MCP Apps / OpenAI Apps SDK standard host style-variable names to kohaku's
 * `KnownThemeTokens`. The source of truth for the variable names is
 * `@modelcontextprotocol/ext-apps`'s `McpUiStyleVariableKey` (the type of
 * `hostContext.styles.variables`'s keys) — see `node_modules/@modelcontextprotocol/ext-apps/dist/src/spec.types.d.ts`.
 *
 * Only host variables with an unambiguous 1:1 semantic correspondence to a known
 * kohaku token are mapped. Notably out of scope:
 * - `color.primary` (kohaku's brand/button-fill accent): no host standard variable
 *   names a generic brand/accent color (the host's own "-primary" suffix means
 *   "the primary tone of that family", e.g. "the main background", not "brand
 *   accent") — left unmapped so it keeps following `base`.
 * - `--color-background-inverse` / `--color-text-inverse` (and the rest of the
 *   host's `-inverse` family, e.g. `--color-border-inverse`): in the host
 *   vocabulary `inverse` is a background/text/border/ring group meaning "the
 *   palette to use for content sitting on an inverted background surface", a
 *   concept kohaku has no equivalent for. kohaku's nearest-sounding token,
 *   `color.on-primary`, is instead the foreground drawn ON the primary/negative
 *   FILL (`color.primary` / `color.negative`), and its white value was chosen by
 *   measuring ≥4.5:1 contrast specifically against kohaku's own fill colors (see
 *   the dark-theme AA test below). A fill token and its foreground token are only
 *   ever mapped as a pair; adopting the host's inverse text color while leaving
 *   the fill at kohaku's default would break that measured pairing and could
 *   make `action.button` / `presentForm` submit labels unreadable on a host whose
 *   inverse text is dark. Since kohaku has no "inverted surface" concept to pair
 *   it with, neither `--color-background-inverse` nor `--color-text-inverse` is
 *   mapped.
 * - `chart.axis` / `chart.palette`: no host variable corresponds to chart-specific
 *   colors — left unmapped.
 * - Font, radius and shadow variables (`--font-*`, `--border-radius-*`,
 *   `--shadow-*`): before this file had non-color tokens, none of these had
 *   anything to map onto. That is no longer true for family and shape:
 *   `--font-sans` / `--font-mono` correspond 1:1 to `font.family.sans` /
 *   `font.family.mono`, and the host's radius (`--border-radius-xs`…`full`) and
 *   shadow (`--shadow-hairline`/`sm`/`md`/`lg`) families correspond to `radius.*`
 *   / `shadow.*`. They are left unmapped by this change anyway, deliberately:
 *   adopting host values here would change rendering for MCP hosts, a behavior
 *   change this task does not carry (no test, no changeset). Font size has no
 *   single mapping regardless — the host splits text (4 steps) and heading
 *   (7 steps) into two ladders against kohaku's one six-step `font.size.xs`…
 *   `2xl`, so a size mapping needs a decision, not a rename. Wiring any of this
 *   up is a follow-up.
 *
 * Exported so a host integration can extend or override it (e.g. add a
 * product-specific host's variables) without forking `themeFromHostStyles`.
 */
export const HOST_STYLE_VARIABLE_MAP: Readonly<Record<string, keyof KnownThemeTokens>> = {
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

/**
 * Builds `ThemeTokens` by overlaying `base` (typically `defaultLightTheme` /
 * `defaultDarkTheme`, chosen per `hostContext.theme`) with any standard MCP host
 * style variables (`hostContext.styles.variables`) recognized by `map`.
 *
 * Pure and DOM-free (renderer-core has no DOM lib, unlike ext-apps' own
 * `applyHostStyleVariables`, which mutates `document.documentElement.style`) — this
 * only produces a token object to hand to `RendererProvider`'s `theme` prop /
 * renderer-wc's per-part resolution, so the same host-theme value renders
 * identically through both renderers (parity, matching how `resolveToken` already
 * works for an app-specified `theme`).
 *
 * Values are kept as opaque CSS color strings (no color-space validation) —
 * whatever the host sent is passed through as-is. An unknown host variable name,
 * an empty string, or a missing/`undefined` value is skipped and `base`'s value for
 * that token is kept (fail-open: never throws, never regresses a token that `base`
 * already defines).
 *
 * @param map - The host-variable-name → token lookup table. Defaults to
 * `HOST_STYLE_VARIABLE_MAP`; a host integration can pass its own map (e.g. to add
 * product-specific host variables) without forking this function, exactly as
 * `HOST_STYLE_VARIABLE_MAP`'s own doc comment promises.
 */
export function themeFromHostStyles(
  variables: Record<string, string | undefined>,
  base: ThemeTokens,
  map: Readonly<Record<string, keyof KnownThemeTokens>> = HOST_STYLE_VARIABLE_MAP,
): ThemeTokens {
  const result: ThemeTokens = { ...base };
  for (const [hostVar, value] of Object.entries(variables)) {
    if (value == null || value.trim() === "") continue;
    const tokenName = map[hostVar];
    if (tokenName == null) continue;
    (result as Record<string, string | number>)[tokenName] = value;
  }
  return result;
}

/**
 * Builds the theme CSS injected into the sandbox (L2 freely-generated HTML)
 * (`:root { --kohaku-*: … }`).
 *
 * L2 outputs are contractually written with token references var(--kohaku-*) for
 * their styles when a design system is applied (paired with composer's
 * designSystemPromptFragment / the L2_RAW_COLOR lint). The values are supplied by
 * this CSS at render time — because the Spec (artifact HTML) holds no values, it
 * upholds SPEC-ENV-003 (theme independence) and follows light/dark switching and
 * brand swaps without regeneration.
 *
 * - Because it merges with the default light theme, even a partial theme always
 *   defines a var for every known token (no fallback description is required in the
 *   generated HTML). Dark assumes a complete theme
 *   `{...defaultDarkTheme, ...brand}` is passed (the same default-theme practice as
 *   theme.ts).
 * - `chart.palette` (CSV) is also decomposed into `--kohaku-chart-palette-N`
 *   (1-based) so the generated HTML can reference it by index. Since the prompt
 *   guides 1–7, even a palette with fewer than 7 colors is filled up to 7 entries
 *   by cycling.
 */
export function sandboxThemeCss(theme?: ThemeTokens): string {
  const merged: ThemeTokens = { ...defaultLightTheme, ...theme };
  const vars = themeTokensToCssVars(merged);
  const palette = String(merged["chart.palette"])
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");
  const paletteCount = Math.max(palette.length, 7);
  for (let i = 0; i < paletteCount; i++) {
    vars[`--kohaku-chart-palette-${i + 1}`] = palette[i % palette.length]!;
  }
  // Because it is embedded as-is into srcdoc's <style>, structurally remove forms
  // that cannot stand as a CSS declaration: variable names allow only character
  // classes valid for a CSS custom property (excluding whitespace etc. in custom
  // token names), and values drop characters that break the declaration / tag
  // structure (<>{};) (colors, numbers, and font enumerations are not harmed by
  // this restriction).
  const body = Object.entries(vars)
    .filter(([name]) => /^--[A-Za-z0-9_-]+$/.test(name))
    .map(([name, value]) => `${name}:${value.replace(/[<>{};]/g, "")};`)
    .join("");
  return `:root{${body}}`;
}

/**
 * The non-color tokens resolved into a flat, string-typed bag. Presenters take this instead of calling
 * resolveToken per size token (one resolution per render, identical for React and WC). Resolution goes
 * through resolveToken so the default-light net and theme overrides apply exactly as for colors.
 */
export interface NonColorTokens {
  fontSans: string;
  fontMono: string;
  fontXs: string;
  fontSm: string;
  fontMd: string;
  fontLg: string;
  fontXl: string;
  font2xl: string;
  space1: string;
  space2: string;
  space3: string;
  space4: string;
  space5: string;
  space6: string;
  radiusSm: string;
  radiusMd: string;
  radiusLg: string;
  radiusFull: string;
  shadowSm: string;
  shadowMd: string;
  motionDuration: string;
  motionEasing: string;
}

/**
 * Kept as an alias: `resolveSizing` / `useSizing` / `RenderRuntime.sizing` still say "sizing" (unifying
 * that naming is a separate scope), but the type itself is `NonColorTokens` — 6 of its 22 fields
 * (`fontSans`/`fontMono`, `shadowSm`/`shadowMd`, `motionDuration`/`motionEasing`) are not sizes, and
 * "non-color tokens" is already how the docs and this file's own comments describe the whole group.
 */
export type SizingTokens = NonColorTokens;

export function resolveSizing(theme: ThemeTokens): NonColorTokens {
  const t = (name: keyof KnownThemeTokens): string => String(resolveToken(theme, name));
  return {
    fontSans: t("font.family.sans"),
    fontMono: t("font.family.mono"),
    fontXs: t("font.size.xs"),
    fontSm: t("font.size.sm"),
    fontMd: t("font.size.md"),
    fontLg: t("font.size.lg"),
    fontXl: t("font.size.xl"),
    font2xl: t("font.size.2xl"),
    space1: t("space.1"),
    space2: t("space.2"),
    space3: t("space.3"),
    space4: t("space.4"),
    space5: t("space.5"),
    space6: t("space.6"),
    radiusSm: t("radius.sm"),
    radiusMd: t("radius.md"),
    radiusLg: t("radius.lg"),
    radiusFull: t("radius.full"),
    shadowSm: t("shadow.sm"),
    shadowMd: t("shadow.md"),
    motionDuration: t("motion.duration"),
    motionEasing: t("motion.easing"),
  };
}

/**
 * The resolved default-light sizing bag. Presenters take `sizing: SizingTokens` as a required last
 * parameter (every renderer-react / renderer-wc call site already passes its own resolved `sizing`
 * explicitly). Kept exported for **external** consumers: a product calling a presenter style function
 * directly (outside the two renderers) can pass `DEFAULT_SIZING` to reproduce the exact values a call
 * with no `sizing` argument used to resolve, before `sizing` became mandatory.
 */
export const DEFAULT_SIZING: NonColorTokens = resolveSizing({});
