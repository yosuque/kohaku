import type { DesignSystemGuide } from "@kohaku-ui/composer";

/**
 * This product's design system (applied to L2 free generation. ComposePolicy.designSystem).
 *
 * The token vocabulary uses the composer default (DEFAULT_TOKEN_DESCRIPTIONS = the full set of KnownThemeTokens)
 * as-is, and here we only add product-specific style rules. Generated output writes styles with var(--kohaku-*),
 * and the values are injected by the sandbox at render time (paired with sample-web's buildTheme —
 * follows light/dark switching without regeneration).
 *
 * When adding a custom token, declare it here in tokens and **also supply a value under the same name in
 * sample-web's brand (theme/tokens.ts)** (vocabulary and value are two halves; without a value, var() falls to undefined).
 *
 * If you change the content, always bump the ds suffix of generatorVersion in app.ts
 * (a change in prompt content = generational separation of the cache; the same practice as few-shot).
 */
export const SALES_DESIGN_SYSTEM: DesignSystemGuide = {
  guidelines: [
    "Use spacing in multiples of 4px (4/8/12/16/24).",
    "Use an 8px corner radius and a 1px solid var(--kohaku-color-border) border by default.",
    "Use system-ui fonts (font-family: system-ui, sans-serif); body around 13px and headings around 15px.",
    "Style table header rows with background var(--kohaku-color-surface) and text var(--kohaku-color-muted).",
    "When indicating increases/decreases, use var(--kohaku-color-positive) / var(--kohaku-color-negative) and also show a symbol like ▲▼ (do not rely on color alone).",
  ],
};
