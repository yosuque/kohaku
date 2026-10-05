/**
 * Fires an observability `onError` hook fire-and-forget, swallowing any synchronous throw from the hook itself
 * (an observation-only hook must never mask or replace the caller's own error/result). Generic over the hook's
 * context type so the promotion and fixation services share one implementation. Deliberately local (not
 * imported from composer's fireObserverHook or host-core's notifyHook) because lineage depends on neither
 * (dependency direction).
 */
export function notifyFailOpen<C>(
  onError: ((ctx: C, error: unknown) => void) | undefined,
  ctx: C,
  error: unknown,
): void {
  if (onError == null) return;
  try {
    onError(ctx, error);
  } catch {
    // Swallowed: an observability-only hook must not affect the caller's control flow.
  }
}
