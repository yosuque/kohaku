/**
 * Default display language tag when a renderer's `locale` is unspecified. Used for
 * number/date formatting and sort collation. Kept in sync with DEFAULT_MESSAGES
 * (both are English by default) so the two i18n axes agree when neither is overridden.
 * Single source of truth, consumed by both renderer-react (context.tsx) and
 * renderer-wc (kohaku-surface.ts).
 */
export const DEFAULT_LOCALE = "en-US";

/**
 * Catalog of UI strings the renderers use. Defaults are English (DEFAULT_MESSAGES).
 * Individual entries can be overridden via context.messages, forming the i18n
 * foundation together with locale. When unset, DEFAULT_MESSAGES is used as-is.
 *
 * Framework-free single source of truth, shared by renderer-react and renderer-wc.
 */
export interface RendererMessages {
  /** PresentForm submit button label */
  formSubmit: string;
  /** PresentForm default success message (when props.successMessage is unset) */
  formSubmitted: string;
  /** PresentForm select placeholder when nothing is selected */
  formSelectPlaceholder: string;
  /** PresentForm validation: required field is empty. label is the field display name */
  formRequired: (label: string) => string;
  /** PresentForm validation: below minimum length */
  formMinLength: (label: string, min: number) => string;
  /** PresentForm validation: above maximum length */
  formMaxLength: (label: string, max: number) => string;
  /** PresentForm validation: pattern mismatch */
  formPattern: (label: string) => string;
  /** PresentForm validation: below minimum value (number lower bound) */
  formMin: (label: string, min: number) => string;
  /** PresentForm validation: above maximum value (number upper bound) */
  formMax: (label: string, max: number) => string;
  /** PresentForm validation: aggregate error heading shown when submit is blocked. count is the number of invalid fields */
  formErrorSummary: (count: number) => string;
  /** Shown while data is loading */
  dataLoading: string;
  /** Shown when the data version has advanced and the view is STALE */
  dataStale: string;
  /** Error shown when no binding client is configured */
  bindingMissing: string;
  /** PresentSpreadsheet total row count. total is a pre-formatted string */
  spreadsheetTotal: (total: string, shown: number) => string;
  /** PresentSpreadsheet (serverSide) next-page button label */
  spreadsheetNextPage: string;
  /** PresentSpreadsheet (serverSide) back-to-first-page button label */
  spreadsheetFirstPage: string;
  /** PresentSpreadsheet (editable): aria-label of an idle cell's edit-trigger button. column is the column's display label */
  spreadsheetEditCell: (column: string) => string;
  /** PresentChart default aria-label (when title is unset) */
  chartDefaultLabel: (kind: string) => string;
  /** Fallback text when rendering a node fails */
  nodeRenderFailed: (type: string, id: string) => string;
  /** PresentMetric delta read-out including direction. delta is a signed pre-formatted string */
  metricDelta: (delta: string, direction: "up" | "down" | "flat") => string;
  /** PresentMetric aria-label composition. delta is null when unspecified */
  metricAriaLabel: (label: string, value: string, delta: string | null) => string;
  /** L2 sandbox chrome: the "L2 SANDBOXED" badge label (see presenters/sandbox-chrome.ts) */
  sandboxBadgeLabel: string;
  /** L2 sandbox chrome: the explanatory copy shown next to the badge */
  sandboxBadgeDescription: string;
  /** L2 sandbox chrome: notice text while the iframe is starting up */
  sandboxLoading: string;
  /** L2 sandbox chrome: fallback notice text for an error with no guest-reported detail */
  sandboxErrorFallback: string;
  /** L2 sandbox chrome: notice text when the node has no inline HTML to run */
  sandboxArtifactMissing: string;
  /** L2 sandbox chrome: notice text when the host did not inject the sandbox bridge. type is the component's declared type */
  sandboxBridgeMissing: (type: string) => string;
}

/** Default English strings. The default value of RendererMessages. */
export const DEFAULT_MESSAGES: RendererMessages = {
  formSubmit: "Submit",
  formSubmitted: "Submitted",
  formSelectPlaceholder: "Select an option",
  formRequired: (label) => `${label} is required`,
  formMinLength: (label, min) => `${label} must be at least ${min} characters`,
  formMaxLength: (label, max) => `${label} must be at most ${max} characters`,
  formPattern: (label) => `${label} has an invalid format`,
  formMin: (label, min) => `${label} must be ${min} or greater`,
  formMax: (label, max) => `${label} must be ${max} or less`,
  formErrorSummary: (count) => `${count} issue(s) found in the input`,
  dataLoading: "Loading data…",
  dataStale: "Data has been updated. Refresh the view.",
  bindingMissing: "No binding client is configured",
  spreadsheetTotal: (total, shown) => `Showing ${shown} of ${total} rows`,
  spreadsheetNextPage: "Next",
  spreadsheetFirstPage: "First page",
  spreadsheetEditCell: (column) => `Edit ${column}`,
  chartDefaultLabel: (kind) => `${kind} chart`,
  nodeRenderFailed: (type, id) => `Failed to render component (${type} / ${id})`,
  metricDelta: (delta, direction) =>
    direction === "up" ? `${delta} (up)` : direction === "down" ? `${delta} (down)` : delta,
  metricAriaLabel: (label, value, delta) =>
    delta != null ? `${label}: ${value}, change ${delta}` : `${label}: ${value}`,
  sandboxBadgeLabel: "L2 SANDBOXED",
  sandboxBadgeDescription:
    "Running freely generated HTML in an isolated iframe (network blocked; data passed by reference through the bridge)",
  sandboxLoading: "Starting the sandbox…",
  sandboxErrorFallback: "An error occurred in the sandbox",
  sandboxArtifactMissing: "No sandbox artifact (inline HTML is required)",
  sandboxBridgeMissing: (type) =>
    `Rendering the L2 component (${type}) requires injecting the sandbox bridge`,
};
