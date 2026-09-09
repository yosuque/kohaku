/**
 * Computes which focusable element Tab/Shift+Tab should move focus to, to keep focus trapped
 * within a dialog/overlay (renderer-react's OverlayDialog onKeyDown / renderer-wc's
 * overlayDialog keydown handler — the framework-free source of truth). DOM lookups (querying
 * the focusable elements, reading the active element) stay in the renderer; only the decision
 * of where focus should land is shared.
 *
 * Returns:
 * - "block": there are no focusable elements at all — the caller should preventDefault and stop
 *   (keep the trap even though there is nowhere to move focus).
 * - T: the element to move focus to (wrap to the last on Shift+Tab from the first, or to the
 *   first on Tab from the last) — the caller should preventDefault and focus it.
 * - null: no wrap is needed — the caller should let the default Tab behavior proceed.
 */
export function focusTrapTarget<T>(
  focusables: readonly T[],
  active: T | null,
  shiftKey: boolean,
): "block" | T | null {
  if (focusables.length === 0) return "block";
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}
