/**
 * The default design kit for L2 free generation and the theme-neutral state styles for L1 parts.
 *
 * `defaultDesignKit.css` is injected by the sandbox (mountSandbox's kitCss, default) into the srcdoc
 * AFTER the theme variables (sandboxThemeCss) and BEFORE the generated CSS, so generated styles can
 * override it. It holds no raw colour values — every colour is a `var(--kohaku-color-*)` reference,
 * `currentColor`, or the keyword `transparent` (SPEC-ENV-003 concerns concrete colour *values*, and
 * `transparent` carries none); dimensions are tokens except the deliberate literals: hairline 1px
 * borders, the 2px focus ring, the `.k-badge` 2px vertical padding, the `.k-grid` 160px `minmax` column
 * floor, the 480px grid breakpoint, the `.k-btn:active` .5px press nudge, and the SVG chart geometry
 * (stroke widths / dash pattern).
 *
 * The class vocabulary the composer presents to the model (composer's DEFAULT_KIT_VOCABULARY) is the
 * other wheel of this pair; `packages/sandbox/test/design-kit-contract.test.ts` pins that every class
 * in the vocabulary exists here and that both carry the same id/version. Contract: classes are only
 * ever ADDED within a version — never renamed or removed — so promoted artifacts keep rendering.
 *
 * Base rules deliberately avoid forcing *size* on bare elements (no `table{width:100%}`; only
 * `.k-table` opts in to full width), so artifacts generated before the kit existed keep their
 * existing layout width. The only spacing reset applied to every element (including pre-kit
 * artifacts) is `box-sizing:border-box` and `html,body{margin:0;padding:0}`; UA margins on headings,
 * paragraphs and default `<table>` styling are left alone (`.k-table` sets its own
 * `border-collapse:collapse`), so unstyled prose keeps its familiar spacing.
 */
export interface DesignKit {
  /** Stable identifier (e.g. "kohaku"). Presented in the L2 prompt as `Design kit (<id> v<version>)`. */
  id: string;
  /** Bump when the class vocabulary changes incompatibly (additions do not need a bump). */
  version: string;
  /** The stylesheet text (trusted CSS; no `</` sequence, no raw color values). */
  css: string;
}

const BASE_CSS = [
  "*,*::before,*::after{box-sizing:border-box}",
  "html,body{margin:0;padding:0}",
  "body{font-family:var(--kohaku-font-family-sans);font-size:var(--kohaku-font-size-md);line-height:1.45;color:var(--kohaku-color-text);background:var(--kohaku-color-background);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}",
  "h1,h2,h3,h4{line-height:1.25;font-weight:600;color:var(--kohaku-color-text)}",
  "h1{font-size:var(--kohaku-font-size-xl)}",
  "h2{font-size:var(--kohaku-font-size-lg)}",
  "h3,h4{font-size:var(--kohaku-font-size-md)}",
  "button,input,select,textarea{font:inherit;color:inherit}",
  "code,pre{font-family:var(--kohaku-font-family-mono)}",
  ":focus-visible{outline:2px solid var(--kohaku-color-primary);outline-offset:2px}",
].join("");

// there is no --kohaku-color-warning-border token; warning tones use their surface alone
const TONE_SURFACE = (tone: "positive" | "negative" | "warning" | "info"): string =>
  tone === "warning"
    ? "background:var(--kohaku-color-warning-surface);color:var(--kohaku-color-warning-text);border-color:transparent"
    : `background:var(--kohaku-color-${tone}-surface);color:var(--kohaku-color-${tone}-text);border-color:var(--kohaku-color-${tone}-border)`;

const COMPONENT_CSS = [
  // surfaces & text
  ".k-card{background:var(--kohaku-color-surface);border:1px solid var(--kohaku-color-border);border-radius:var(--kohaku-radius-lg);box-shadow:var(--kohaku-shadow-sm);padding:var(--kohaku-space-4)}",
  ".k-card-title{margin:0;font-size:var(--kohaku-font-size-lg);font-weight:600;margin-bottom:var(--kohaku-space-3)}",
  ".k-title{margin:0;font-size:var(--kohaku-font-size-lg);font-weight:600}",
  ".k-subtitle{margin:0;font-size:var(--kohaku-font-size-sm);color:var(--kohaku-color-muted)}",
  ".k-muted{color:var(--kohaku-color-muted)}",
  ".k-num{font-variant-numeric:tabular-nums;text-align:right}",
  // kpi
  ".k-kpi{display:flex;flex-direction:column;gap:var(--kohaku-space-1)}",
  ".k-kpi-label{font-size:var(--kohaku-font-size-sm);color:var(--kohaku-color-muted)}",
  ".k-kpi-value{font-size:var(--kohaku-font-size-2xl);font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums}",
  ".k-kpi-delta{font-size:var(--kohaku-font-size-sm);font-weight:600;color:var(--kohaku-color-muted)}",
  ".k-kpi-delta.is-up{color:var(--kohaku-color-positive)}",
  ".k-kpi-delta.is-down{color:var(--kohaku-color-negative)}",
  // buttons
  ".k-btn{display:inline-flex;align-items:center;gap:var(--kohaku-space-2);border:1px solid var(--kohaku-color-border);border-radius:var(--kohaku-radius-md);padding:var(--kohaku-space-2) var(--kohaku-space-4);font-size:var(--kohaku-font-size-md);font-weight:600;line-height:1.2;cursor:pointer;background:var(--kohaku-color-surface);color:var(--kohaku-color-text);transition:filter var(--kohaku-motion-duration) var(--kohaku-motion-easing),transform var(--kohaku-motion-duration) var(--kohaku-motion-easing)}",
  ".k-btn:hover{filter:brightness(.96)}",
  ".k-btn:active{transform:translateY(.5px)}",
  ".k-btn:disabled{opacity:.5;cursor:not-allowed}",
  ".k-btn-primary{background:var(--kohaku-color-primary);color:var(--kohaku-color-on-primary);border-color:transparent}",
  ".k-btn-secondary{background:transparent;color:var(--kohaku-color-text);border-color:var(--kohaku-color-border)}",
  ".k-btn-danger{background:var(--kohaku-color-negative);color:var(--kohaku-color-on-primary);border-color:transparent}",
  // table
  ".k-table{width:100%;border-collapse:collapse;font-size:var(--kohaku-font-size-md)}",
  ".k-table th{background:var(--kohaku-color-surface);color:var(--kohaku-color-muted);font-weight:600;font-size:var(--kohaku-font-size-sm);text-align:left;padding:var(--kohaku-space-2) var(--kohaku-space-3);border-bottom:1px solid var(--kohaku-color-border);white-space:nowrap}",
  ".k-table td{padding:var(--kohaku-space-2) var(--kohaku-space-3);border-bottom:1px solid var(--kohaku-color-border);vertical-align:middle}",
  ".k-table tbody tr:hover td{background:color-mix(in srgb,currentColor 5%,transparent)}",
  ".k-table th.k-num,.k-table td.k-num{text-align:right}",
  // badge / notice
  ".k-badge{display:inline-block;border-radius:var(--kohaku-radius-full);padding:2px var(--kohaku-space-2);font-size:var(--kohaku-font-size-xs);font-weight:600;line-height:1.4;background:var(--kohaku-color-surface);color:var(--kohaku-color-muted);border:1px solid var(--kohaku-color-border)}",
  `.k-badge-positive{${TONE_SURFACE("positive")}}`,
  `.k-badge-negative{${TONE_SURFACE("negative")}}`,
  `.k-badge-warning{${TONE_SURFACE("warning")}}`,
  `.k-badge-info{${TONE_SURFACE("info")}}`,
  ".k-notice{border-radius:var(--kohaku-radius-md);padding:var(--kohaku-space-3) var(--kohaku-space-4);font-size:var(--kohaku-font-size-sm);background:var(--kohaku-color-surface);color:var(--kohaku-color-muted);border:1px solid var(--kohaku-color-border)}",
  `.k-notice-positive{${TONE_SURFACE("positive")}}`,
  `.k-notice-negative{${TONE_SURFACE("negative")}}`,
  `.k-notice-warning{${TONE_SURFACE("warning")}}`,
  `.k-notice-info{${TONE_SURFACE("info")}}`,
  // layout
  ".k-stack{display:flex;flex-direction:column;gap:var(--kohaku-space-4)}",
  ".k-row{display:flex;flex-direction:row;align-items:center;gap:var(--kohaku-space-3);flex-wrap:wrap}",
  ".k-grid{display:grid;gap:var(--kohaku-space-4);grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}",
  ".k-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}",
  ".k-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}",
  ".k-grid-4{grid-template-columns:repeat(4,minmax(0,1fr))}",
  "@media (max-width:480px){.k-grid-2,.k-grid-3,.k-grid-4{grid-template-columns:1fr}}",
  // form
  ".k-label{font-size:var(--kohaku-font-size-sm);font-weight:600;color:var(--kohaku-color-text)}",
  ".k-input,.k-select{width:100%;border:1px solid var(--kohaku-color-border);border-radius:var(--kohaku-radius-md);padding:var(--kohaku-space-2) var(--kohaku-space-3);font-size:var(--kohaku-font-size-md);background:var(--kohaku-color-background);color:var(--kohaku-color-text)}",
  // chart (SVG)
  ".k-chart{width:100%;height:auto;display:block}",
  ".k-chart .k-axis{stroke:var(--kohaku-chart-axis);stroke-width:1;fill:none}",
  ".k-chart .k-gridline{stroke:var(--kohaku-color-border);stroke-width:1;stroke-dasharray:2 3;fill:none}",
  ".k-chart .k-tick{fill:var(--kohaku-color-muted);font-size:var(--kohaku-font-size-xs)}",
  ".k-chart .k-axis-label{fill:var(--kohaku-color-muted);font-size:var(--kohaku-font-size-sm)}",
  ...[1, 2, 3, 4, 5, 6, 7].map(
    (n) =>
      `.k-chart .k-series-${n}{fill:var(--kohaku-chart-palette-${n});stroke:var(--kohaku-chart-palette-${n})}`,
  ),
  ".k-chart .k-bar{rx:var(--kohaku-radius-sm)}",
  ".k-chart .k-line{fill:none;stroke-width:2}",
].join("");

const SCALE = [1, 2, 3, 4, 5, 6] as const;
const UTILITY_CSS = [
  // layout
  ".flex{display:flex}",
  ".grid{display:grid}",
  ".hidden{display:none}",
  ".w-full{width:100%}",
  ".h-full{height:100%}",
  ".flex-col{flex-direction:column}",
  ".flex-wrap{flex-wrap:wrap}",
  ".items-center{align-items:center}",
  ".items-start{align-items:flex-start}",
  ".justify-between{justify-content:space-between}",
  ".justify-end{justify-content:flex-end}",
  ".grid-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}",
  ".grid-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}",
  ".grid-cols-4{grid-template-columns:repeat(4,minmax(0,1fr))}",
  // gap
  ...SCALE.map((n) => `.gap-${n}{gap:var(--kohaku-space-${n})}`),
  // padding
  ...SCALE.map((n) => `.p-${n}{padding:var(--kohaku-space-${n})}`),
  ...SCALE.map(
    (n) => `.px-${n}{padding-left:var(--kohaku-space-${n});padding-right:var(--kohaku-space-${n})}`,
  ),
  ...SCALE.map(
    (n) => `.py-${n}{padding-top:var(--kohaku-space-${n});padding-bottom:var(--kohaku-space-${n})}`,
  ),
  ...SCALE.map((n) => `.pt-${n}{padding-top:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.pb-${n}{padding-bottom:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.pl-${n}{padding-left:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.pr-${n}{padding-right:var(--kohaku-space-${n})}`),
  // margin
  ".m-0{margin:0}",
  ...SCALE.map((n) => `.m-${n}{margin:var(--kohaku-space-${n})}`),
  ".mx-auto{margin-left:auto;margin-right:auto}",
  ...SCALE.map((n) => `.mx-${n}{margin-left:var(--kohaku-space-${n});margin-right:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.my-${n}{margin-top:var(--kohaku-space-${n});margin-bottom:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.mt-${n}{margin-top:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.mb-${n}{margin-bottom:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.ml-${n}{margin-left:var(--kohaku-space-${n})}`),
  ...SCALE.map((n) => `.mr-${n}{margin-right:var(--kohaku-space-${n})}`),
  // text
  ".text-xs{font-size:var(--kohaku-font-size-xs)}",
  ".text-sm{font-size:var(--kohaku-font-size-sm)}",
  ".text-md{font-size:var(--kohaku-font-size-md)}",
  ".text-lg{font-size:var(--kohaku-font-size-lg)}",
  ".text-xl{font-size:var(--kohaku-font-size-xl)}",
  ".text-2xl{font-size:var(--kohaku-font-size-2xl)}",
  ".text-muted{color:var(--kohaku-color-muted)}",
  ".text-primary{color:var(--kohaku-color-primary)}",
  ".text-positive{color:var(--kohaku-color-positive)}",
  ".text-negative{color:var(--kohaku-color-negative)}",
  ".text-left{text-align:left}",
  ".text-center{text-align:center}",
  ".text-right{text-align:right}",
  ".truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".tabular-nums{font-variant-numeric:tabular-nums}",
  // font
  ".font-medium{font-weight:500}",
  ".font-semibold{font-weight:600}",
  ".font-bold{font-weight:700}",
  // radius
  ".rounded-sm{border-radius:var(--kohaku-radius-sm)}",
  ".rounded-md{border-radius:var(--kohaku-radius-md)}",
  ".rounded-lg{border-radius:var(--kohaku-radius-lg)}",
  ".rounded-full{border-radius:var(--kohaku-radius-full)}",
  // shadow
  ".shadow-sm{box-shadow:var(--kohaku-shadow-sm)}",
  ".shadow-md{box-shadow:var(--kohaku-shadow-md)}",
  // border
  ".border{border:1px solid var(--kohaku-color-border)}",
  ".border-b{border-bottom:1px solid var(--kohaku-color-border)}",
  // background
  ".bg-surface{background:var(--kohaku-color-surface)}",
  ".bg-background{background:var(--kohaku-color-background)}",
].join("");

// Concatenation order is load-bearing: at equal specificity, later rules win, so UTILITY_CSS must
// stay last to override COMPONENT_CSS (e.g. `.text-muted` on a `.k-card-title`) — do not reorder.
export const defaultDesignKit: DesignKit = {
  id: "kohaku",
  version: "1",
  css: `${BASE_CSS}${COMPONENT_CSS}${UTILITY_CSS}`,
};

/**
 * Theme-neutral hover / active / focus-visible rules for the L1 parts, scoped to a kohaku subtree.
 * Each rule's selector list is scoped per selector, not per rule: parts carry `data-kohaku` on their
 * own root element (e.g. `packages/renderer-react/src/core/action-button.tsx` renders
 * `<button data-kohaku={node.id} …>`), so a plain descendant combinator (`[data-kohaku] button`) never
 * matches a part whose root IS that button — an element is not its own descendant. Every rule therefore
 * pairs a descendant form with an "own root" form (`button[data-kohaku]`, `[data-kohaku]:focus-visible`)
 * so a Spec whose root is the styled element still gets the state style.
 *
 * They hold no values: every effect derives from the element's own inline colors (`currentColor`,
 * `filter`, `color-mix` with `transparent`), so one static stylesheet serves every theme and several
 * RendererProviders on one page never collide. Injected once per document by renderer-react's
 * RendererProvider (React 19 hoisted `<style href precedence>`) and once per shadow root by renderer-wc.
 * The pixel-match mechanism (inline resolved tokens) is untouched: these rules only add interaction states.
 *
 * The focus ring is drawn INSIDE the element (`outline-offset:-2px`) in `currentColor`, which by the
 * theme's AA color pairing always contrasts with that element's own background — so it stays visible on
 * a filled primary button, where an outside ring in text color would vanish against the page background
 * it sits on instead of against the button.
 */
export const PARTS_STATE_CSS = [
  "[data-kohaku] button:not(:disabled):hover,button[data-kohaku]:not(:disabled):hover{filter:brightness(.96)}",
  "[data-kohaku] button:not(:disabled):active,button[data-kohaku]:not(:disabled):active{transform:translateY(.5px)}",
  "[data-kohaku] tbody tr:hover td{background:color-mix(in srgb,currentColor 5%,transparent)}",
  "[data-kohaku] :focus-visible,[data-kohaku]:focus-visible{outline:2px solid currentColor;outline-offset:-2px}",
].join("");
