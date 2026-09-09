/**
 * Style that hides an element visually but still exposes it to assistive
 * technology (screen readers) — the "clip" pattern. Unlike display:none /
 * visibility:hidden, it remains in the accessibility tree. Used for elements that
 * should not be shown visually but must be read aloud, such as the data-table
 * alternative for charts.
 *
 * To stay framework-free we dropped the dependency on React's CSSProperties and
 * use a plain Record<string, string | number>. renderer-react can assign it
 * directly to CSSProperties, and renderer-wc sets it onto element.style one
 * property at a time. The values are identical across both renderers.
 */
export const visuallyHiddenStyle: Record<string, string | number> = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Selector for focusable elements (used by overlay.dialog for its focus trap and
 * for scanning the initial focus target). Excludes disabled elements and
 * tabindex="-1". Because both renderers use this single definition, the set of
 * "trappable" elements matches (querySelectorAll and .focus() themselves are
 * DOM-dependent and are done on each renderer side; only the definition is
 * centralized here).
 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * True for the keys that activate a keyboard-operable element styled as a button (an ARIA
 * role="button" on a non-button element, e.g. a row / list item / chart point). Shared so both
 * renderers treat Enter and Space identically (Space's default page-scroll must still be
 * suppressed by the caller via preventDefault).
 */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " ";
}
