import { DEFAULT_KIT_VOCABULARY, type DesignSystemGuide } from "@kohaku-ui/composer";

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
 *
 * Never write a concrete value (a color, a px number) here — values live only in the tokens/kit, never in this guide.
 */
export const SALES_DESIGN_SYSTEM: DesignSystemGuide = {
  // The built-in kit: component classes + utilities the model composes with. The CSS is injected by the
  // sandbox at render time (renderer-core's defaultDesignKit — sample-web passes nothing, so the default applies).
  kit: DEFAULT_KIT_VOCABULARY,
  guidelines: [
    "Style table header rows with the k-table class (muted header on the surface color).",
    "When indicating increases/decreases, use k-kpi-delta with is-up / is-down (or var(--kohaku-color-positive) / var(--kohaku-color-negative)) and also show a symbol like ▲▼ (do not rely on color alone).",
  ],
};
