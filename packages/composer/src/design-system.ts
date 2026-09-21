import type { KnownThemeTokens } from "@kohaku-ui/spec-core";

/**
 * Design-system application to L2 free generation (ComposePolicy.designSystem).
 *
 * Baking concrete color values into the generated HTML would break the Spec's theme independence
 * (SPEC-ENV-003) and the cache's cross-theme reuse, so the prompt presents **only token names and
 * usage descriptions**, and the output is made to write token references (var(--kohaku-*)). The actual
 * values are injected by the sandbox as `:root` CSS custom properties at render time (renderer-core's
 * sandboxThemeCss). This makes the output follow light/dark switching and brand-theme swaps without regeneration.
 *
 * This module is exposed under the `@kohaku-ui/composer/design-system` subpath (alongside the barrel)
 * so that downstream node-independent packages (e.g. sandbox's `"types": []`) can import
 * DEFAULT_KIT_VOCABULARY without pulling in composer's full index.ts, which re-exports compose.ts and
 * therefore `@kohaku-ui/llm`'s `process.env` usage — the same reason l2-api.ts carries its own note.
 * Keep this module's own import graph free of `@kohaku-ui/llm` so that guarantee holds.
 */
export interface DesignSystemGuide {
  /**
   * Token vocabulary (token name → usage description). Merged into the default vocabulary
   * (DEFAULT_TOKEN_DESCRIPTIONS) — used both to override the descriptions of known tokens and to add
   * product-specific tokens. Custom tokens must also supply a value under the same name to the
   * render-side theme (ThemeTokens' open index signature) (without one, var() becomes undefined and
   * falls to a transparent/inherited value).
   * **Do not write values here** (values live in the theme; do not put them in the prompt either).
   */
  tokens?: Record<string, string>;
  /**
   * Natural-language style rules (typography, spacing, tone, etc.). Listed as bullet points in the
   * prompt's design-system section. Free-form text equivalent to Claude Code's design-system skill.
   */
  guidelines?: string[];
  /**
   * Whether to lint (L2_RAW_COLOR) raw color values in the output (#hex / rgb() / hsl()) and send them
   * back for repair. Default true (enforcement is the default once designSystem is set). Can be set to
   * false as a safety valve when repair does not converge on a small model and the fallback rate rises
   * (the prompt instruction remains).
   */
  enforceTokenColors?: boolean;
  /**
   * The design kit vocabulary (class names + descriptions, utilities, lint namespaces). When set, the
   * L2 prompt gains a "Design kit" section (designKitPromptFragment) and the L2_UNKNOWN_CLASS lint
   * rejects kit-namespaced class names that are not in the vocabulary. The other wheel is the render
   * side: the kit CSS the sandbox injects (renderer-core's defaultDesignKit.css by default, or the
   * product's own via mountSandbox's kitCss). Use DEFAULT_KIT_VOCABULARY for the built-in kit.
   * Explicit opt-in: unset keeps the prompt bytes of a kit-less design system unchanged.
   */
  kit?: DesignKitVocabulary;
  /**
   * Whether to lint (L2_UNKNOWN_CLASS) kit-namespaced class names that are not in `kit`. Default true
   * once `kit` is set. The same safety valve as enforceTokenColors: set false when repair does not
   * converge on a small model (the prompt section remains).
   */
  enforceKitClasses?: boolean;
}

/**
 * The subset of KnownThemeTokens this table documents: every known token except the two deprecated
 * aliases (color.danger / color.focus, not put on the generation vocabulary) and chart.palette (a
 * CSV-string token guided separately, in indexed form, by designSystemPromptFragment itself).
 */
type BuiltinTokenName = Exclude<keyof KnownThemeTokens, "color.danger" | "color.focus" | "chart.palette">;

/**
 * Default token vocabulary (usage descriptions for KnownThemeTokens). For prompt presentation only and
 * **holds no values** (the values are owned by renderer-core's default theme and injected at render time).
 * Deprecated aliases (color.danger / color.focus) are not put on the generation vocabulary.
 * Because chart.palette is a CSV-string token, designSystemPromptFragment — not this table — guides it
 * in indexed form (--kohaku-chart-palette-N).
 *
 * The ordering is the prompt output order itself (a contract to string-match the Python implementation; change both languages together).
 *
 * Typed `satisfies Record<BuiltinTokenName, string>` (a Required record over every documented known
 * token, not `Partial<...> & Record<string, string>`) so both a typo in a key and an accidentally
 * omitted known token are compile errors: the previous intersection's open `Record<string, string>`
 * index signature absorbed any key, so neither case was ever caught. Product-specific custom tokens are
 * still accepted where they actually are — DesignSystemGuide.tokens' own `Record<string, string>` — this
 * table only documents the fixed built-in vocabulary and is not where a product adds its own tokens.
 */
export const DEFAULT_TOKEN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "color.background": "page/root background",
  "color.surface": "surface of cards, panels, and table headers",
  "color.border": "borders and separators",
  "color.text": "text color for headings and body",
  "color.muted": "secondary text, captions, axis labels",
  "color.on-primary": "foreground on primary/negative fills (button text etc.)",
  "color.primary": "brand primary color (emphasis, button fill, selected state)",
  "color.positive": "emphasis color for increase, rise, success",
  "color.positive.surface": "background surface of success notices",
  "color.positive.text": "text color of success notices",
  "color.positive.border": "border of success notices",
  "color.negative": "emphasis color for decrease, decline, danger",
  "color.negative.surface": "background surface of error notices",
  "color.negative.text": "text color of error notices",
  "color.negative.border": "border of error notices",
  "color.warning.surface": "background surface of warning notices",
  "color.warning.text": "text color of warning notices",
  "color.info.surface": "background surface of info notices",
  "color.info.text": "text color of info notices",
  "color.info.border": "border of info notices",
  "chart.axis": "chart axis lines, ticks, grid lines",
  "font.family.sans": "sans-serif font stack for all text",
  "font.family.mono": "monospace font stack (code, raw values)",
  "font.size.xs": "smallest text (captions, axis ticks)",
  "font.size.sm": "small text (labels, helper text)",
  "font.size.md": "body text",
  "font.size.lg": "section titles",
  "font.size.xl": "page titles",
  "font.size.2xl": "large KPI values",
  "space.1": "4px spacing step",
  "space.2": "8px spacing step",
  "space.3": "12px spacing step",
  "space.4": "16px spacing step",
  "space.5": "24px spacing step",
  "space.6": "32px spacing step",
  "radius.sm": "small corner radius (inputs, badges)",
  "radius.md": "medium corner radius (buttons, notices)",
  "radius.lg": "large corner radius (cards, dialogs)",
  "radius.full": "pill radius",
  "shadow.sm": "subtle elevation shadow (cards)",
  "shadow.md": "stronger elevation shadow (dialogs, toasts)",
  "motion.duration": "transition duration",
  "motion.easing": "transition easing",
} satisfies Record<BuiltinTokenName, string>;

/** Token name → CSS custom property name (same conversion rule as renderer-core's themeTokensToCssVars). */
export function tokenToCssVar(name: string): string {
  return `--kohaku-${name.replace(/\./g, "-")}`;
}

/**
 * Builds the "design system" section of the L2 prompt (buildL2Prompt inserts it only when designSystem
 * is specified). Enumerates the default vocabulary + guide.tokens (description overrides, custom-token
 * additions). Custom tokens are listed after the default vocabulary in **ascending name order** (a
 * determinism contract to emit the same string in TS/Python).
 */
export function designSystemPromptFragment(guide: DesignSystemGuide): string {
  const custom = guide.tokens ?? {};
  const lines: string[] = [
    "## Design system (must be followed)",
    "- Always specify colors with CSS custom properties (design tokens). Hard-coding #hex, rgb(), hsl(), or color names is forbidden (the host injects the token values, adapting automatically to both light and dark themes)",
    "- Default the background to var(--kohaku-color-background) and the text color to var(--kohaku-color-text)",
    "- Available tokens:",
  ];
  for (const [name, defaultDescription] of Object.entries(DEFAULT_TOKEN_DESCRIPTIONS)) {
    lines.push(`  - var(${tokenToCssVar(name)}): ${custom[name] ?? defaultDescription}`);
  }
  lines.push(
    "  - var(--kohaku-chart-palette-1) … var(--kohaku-chart-palette-7): chart series colors (use from 1 upward)",
  );
  const extraNames = Object.keys(custom)
    .filter((name) => !(name in DEFAULT_TOKEN_DESCRIPTIONS) && name !== "chart.palette")
    .sort();
  for (const name of extraNames) {
    lines.push(`  - var(${tokenToCssVar(name)}): ${custom[name]}`);
  }
  if (guide.guidelines != null && guide.guidelines.length > 0) {
    lines.push("- Additional style rules:");
    for (const rule of guide.guidelines) {
      lines.push(`  - ${rule}`);
    }
  }
  return lines.join("\n");
}

/**
 * The class vocabulary of a design kit as presented to the L2 model. Holds names and usage descriptions
 * only — the CSS lives on the render side (renderer-core's defaultDesignKit for the built-in kit).
 */
export interface DesignKitVocabulary {
  /** Must equal the render-side kit's id (e.g. "kohaku"). */
  id: string;
  /** Must equal the render-side kit's version. */
  version: string;
  /** Component class name → usage description, in prompt order. */
  classes: Record<string, string>;
  /** Utility class names that exist (exactly these; listed on one prompt line). */
  utilities: readonly string[];
  /**
   * Prefixes the L2_UNKNOWN_CLASS lint treats as "kit namespace": a class starting with one of these
   * but absent from `classes` / `utilities` is sent back for repair. Dash-less utilities (flex, grid,
   * border, …) are matched exactly and are not namespaces, so a model's own `grid-container` passes.
   */
  namespaces: readonly string[];
  /** Overrides the built-in DEFAULT_KIT_SKELETON in the prompt (a body fragment using the kit classes). */
  skeleton?: string;
}

/** A minimal, well-formed widget body using the built-in kit (shown in the prompt, indented by two spaces). */
export const DEFAULT_KIT_SKELETON = [
  '<div class="k-card">',
  '  <div class="k-card-title">Sales by region</div>',
  '  <div class="k-grid k-grid-3 mb-4">',
  '    <div class="k-kpi"><span class="k-kpi-label">Total</span><span class="k-kpi-value">1,234</span><span class="k-kpi-delta is-up">▲ +12%</span></div>',
  "  </div>",
  '  <table class="k-table">',
  '    <thead><tr><th>Region</th><th class="k-num">Sales</th></tr></thead>',
  '    <tbody><tr><td>East</td><td class="k-num">1,234</td></tr></tbody>',
  "  </table>",
  '  <div class="k-notice k-notice-info mt-4 hidden" id="empty">No data for this period</div>',
  "</div>",
].join("\n");

const KIT_UTILITIES: readonly string[] = [
  "flex",
  "grid",
  "hidden",
  "w-full",
  "h-full",
  "flex-col",
  "flex-wrap",
  "items-center",
  "items-start",
  "justify-between",
  "justify-end",
  "grid-cols-2",
  "grid-cols-3",
  "grid-cols-4",
  ...[1, 2, 3, 4, 5, 6].map((n) => `gap-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `p-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `px-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `py-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pt-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pb-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pl-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `pr-${n}`),
  "m-0",
  ...[1, 2, 3, 4, 5, 6].map((n) => `m-${n}`),
  "mx-auto",
  ...[1, 2, 3, 4, 5, 6].map((n) => `mx-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `my-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `mt-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `mb-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `ml-${n}`),
  ...[1, 2, 3, 4, 5, 6].map((n) => `mr-${n}`),
  "text-xs",
  "text-sm",
  "text-md",
  "text-lg",
  "text-xl",
  "text-2xl",
  "text-muted",
  "text-primary",
  "text-positive",
  "text-negative",
  "text-left",
  "text-center",
  "text-right",
  "truncate",
  "tabular-nums",
  "font-medium",
  "font-semibold",
  "font-bold",
  "rounded-sm",
  "rounded-md",
  "rounded-lg",
  "rounded-full",
  "shadow-sm",
  "shadow-md",
  "border",
  "border-b",
  "bg-surface",
  "bg-background",
];

/**
 * The built-in kit vocabulary (pairs with renderer-core's defaultDesignKit; the contract test in
 * packages/sandbox/test/design-kit-contract.test.ts pins every class here to a selector there).
 * Insertion order is the prompt order (a cross-language string contract with Python's DEFAULT_KIT_VOCABULARY).
 */
export const DEFAULT_KIT_VOCABULARY: DesignKitVocabulary = {
  id: "kohaku",
  version: "1",
  classes: {
    "k-card":
      "surface container (border, large radius, subtle shadow, padding); put k-card-title first inside it",
    "k-card-title": "title row of a k-card",
    "k-title": "section title text",
    "k-subtitle": "small muted text under a title",
    "k-muted": "muted (secondary) text color",
    "k-num": "numeric cell/text — tabular figures, right-aligned",
    "k-kpi": "a KPI block; children k-kpi-label, k-kpi-value, k-kpi-delta",
    "k-kpi-label": "small muted label above a KPI value",
    "k-kpi-value": "the large KPI number",
    "k-kpi-delta": "change indicator; add is-up or is-down for the color and keep a ▲/▼ symbol in the text",
    "k-btn": "button base; combine with k-btn-primary, k-btn-secondary or k-btn-danger",
    "k-btn-primary": "filled brand-color button",
    "k-btn-secondary": "outline button",
    "k-btn-danger": "filled danger button",
    "k-table": "data table (muted header row, row dividers, hover); add k-num to numeric th/td",
    "k-badge":
      "small pill; add k-badge-positive / k-badge-negative / k-badge-warning / k-badge-info for tone",
    "k-badge-positive": "success tone badge",
    "k-badge-negative": "error/decline tone badge",
    "k-badge-warning": "warning tone badge",
    "k-badge-info": "info tone badge",
    "k-notice":
      "inline notice box for empty / error / loading states; add k-notice-positive / k-notice-negative / k-notice-warning / k-notice-info for tone",
    "k-notice-positive": "success notice",
    "k-notice-negative": "error notice",
    "k-notice-warning": "warning notice",
    "k-notice-info": "info notice",
    "k-stack": "vertical flex column with medium gap",
    "k-row": "horizontal flex row, centered, wrapping, small gap",
    "k-grid":
      "responsive auto-fit grid; add k-grid-2 / k-grid-3 / k-grid-4 for a fixed column count (collapses to one column on narrow widths)",
    "k-grid-2": "two equal columns",
    "k-grid-3": "three equal columns",
    "k-grid-4": "four equal columns",
    "k-label": "form field label",
    "k-input": "text input",
    "k-select": "select control",
    "k-chart":
      "put on the <svg> root (width 100%, fixed viewBox); the chart classes below (k-axis … k-line) apply only to elements inside it",
    "k-axis": "axis line (<line>/<path>)",
    "k-gridline": "dashed horizontal grid line",
    "k-tick": "tick label (<text>)",
    "k-axis-label": "axis title (<text>)",
    "k-series-1": "series color 1 (fill and stroke); k-series-2 … k-series-7 likewise",
    "k-series-2": "series color 2",
    "k-series-3": "series color 3",
    "k-series-4": "series color 4",
    "k-series-5": "series color 5",
    "k-series-6": "series color 6",
    "k-series-7": "series color 7",
    "k-bar": "bar rect (rounded corners)",
    "k-line": "line-chart path (no fill, 2px stroke)",
  },
  utilities: KIT_UTILITIES,
  namespaces: [
    "k-",
    "gap-",
    "p-",
    "px-",
    "py-",
    "pt-",
    "pb-",
    "pl-",
    "pr-",
    "m-",
    "mx-",
    "my-",
    "mt-",
    "mb-",
    "ml-",
    "mr-",
    "text-",
    "font-",
    "rounded-",
    "shadow-",
    "bg-",
    "grid-cols-",
    "items-",
    "justify-",
    "flex-",
    "border-",
    "w-",
    "h-",
  ],
};

/**
 * Builds the "Design kit" section of the L2 prompt (buildL2PromptStatic inserts it right after the
 * design-system section, only when designSystem.kit is set). Character-for-character identical with
 * Python's design_kit_prompt_fragment.
 */
export function designKitPromptFragment(kit: DesignKitVocabulary): string {
  const lines: string[] = [
    `## Design kit (${kit.id} v${kit.version})`,
    "- The host injects a base stylesheet: body already has the font, text color, background and line-height; headings are scaled; :focus-visible rings are provided. Do not restate these",
    "- Prefer the component classes below for common blocks; use the utilities for layout and spacing; write custom CSS only for what they do not cover, and then only with var(--kohaku-*) tokens",
    "- Component classes:",
  ];
  for (const [name, description] of Object.entries(kit.classes)) lines.push(`  - ${name}: ${description}`);
  lines.push(
    `- Utilities (exactly these names exist; any other utility name has no effect): ${kit.utilities.join(", ")}`,
  );
  lines.push(
    `- Reserved prefixes (kit namespace; never use them for your own class names — pick names like chart-…, panel-…): ${kit.namespaces.join(", ")}`,
  );
  lines.push("- Skeleton of a well-formed widget body (adapt it; do not copy verbatim):");
  for (const line of (kit.skeleton ?? DEFAULT_KIT_SKELETON).split("\n")) lines.push(`  ${line}`);
  return lines.join("\n");
}
