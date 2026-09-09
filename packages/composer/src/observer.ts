import type {
  BudgetCheckErrorContext,
  ComposeContext,
  ComposeErrorContext,
  ComposeObserver,
} from "./context.js";

/**
 * Fires an observation-only hook fire-and-forget (common to onComposed / onError / onBudgetCheckError).
 * A synchronous throw is swallowed with try/catch, and if the return value is a Promise, a reject is absorbed
 * with .catch (prevents unhandledRejection). Promise.resolve is harmless even for void. Does not propagate to
 * the compose body's error or result (the single implementation of context.ts's fire-and-forget contract).
 */
export function fireObserverHook(fn: () => unknown): void {
  try {
    void Promise.resolve(fn()).catch(() => {});
  } catch {
    // Do not let an observation-only hook's synchronous exception overwrite compose's error/result
  }
}

/**
 * Notifies the observation hook (observer.onError) of a compose failure. A throw / reject from the
 * hook is swallowed and does not propagate to the compose body's error or result (observation-only; the same fire-and-forget policy as onComposed).
 */
export function reportComposeError(ctx: ComposeContext, context: ComposeErrorContext, error: unknown): void {
  const hook = ctx.observer?.onError;
  if (hook == null) return;
  fireObserverHook(() => hook(context, error));
}

/**
 * Forwards the occurrence of a fail-open-swallowed throw from the budget hook check() to the observation
 * hook (observer.onBudgetCheckError). The same fire-and-forget as onError (a throw / reject from the
 * hook is swallowed and does not propagate to the compose body). **This is not a failure notification**:
 * generation continues and a Spec may be delivered normally afterward.
 */
export function reportBudgetCheckError(
  ctx: ComposeContext,
  context: BudgetCheckErrorContext,
  error: unknown,
): void {
  const hook = ctx.observer?.onBudgetCheckError;
  if (hook == null) return;
  fireObserverHook(() => hook(context, error));
}

/**
 * Combines any number of ComposeObserver instances into a single one that calls every input observer's
 * matching hook for each event (built for @kohaku-ui/otel's createOtelComposeObserver, so a product can
 * run an OTel observer alongside its own onComposed/onError/onBudgetCheckError without either silently
 * replacing the other — but it is a generic ComposeObserver combinator, not otel-specific).
 *
 * Each input observer's hook call is independently wrapped in fireObserverHook, so one observer throwing
 * (synchronously or via a rejected Promise) never prevents the other observers in the list from running,
 * and — as with any ComposeObserver hook — never propagates to the compose body's error or result. This is
 * a stronger guarantee than merely relying on the composer's own outer fireObserverHook wrap around the
 * merged observer's hook call, which would only stop the *first* throwing observer from blocking the rest
 * if the per-observer isolation below did not exist.
 *
 * A merged hook (onComposed/onError/onBudgetCheckError) is present on the returned observer only when at
 * least one input observer declares it, so composeObservers() with no hookful observers returns `{}` (an
 * observer indistinguishable from "unwired", matching ComposeObserver's existing optional-hooks contract).
 * `undefined` entries are ignored (convenient for a conditionally-wired observer, e.g. `composeObservers(base, enabled ? otelObserver : undefined)`).
 */
export function composeObservers(...observers: Array<ComposeObserver | undefined>): ComposeObserver {
  const list = observers.filter((o): o is ComposeObserver => o != null);
  const merged: ComposeObserver = {};
  if (list.some((o) => o.onComposed != null)) {
    merged.onComposed = (trace, spec) => {
      for (const o of list) {
        const hook = o.onComposed;
        if (hook != null) fireObserverHook(() => hook(trace, spec));
      }
    };
  }
  if (list.some((o) => o.onError != null)) {
    merged.onError = (context, error) => {
      for (const o of list) {
        const hook = o.onError;
        if (hook != null) fireObserverHook(() => hook(context, error));
      }
    };
  }
  if (list.some((o) => o.onBudgetCheckError != null)) {
    merged.onBudgetCheckError = (context, error) => {
      for (const o of list) {
        const hook = o.onBudgetCheckError;
        if (hook != null) fireObserverHook(() => hook(context, error));
      }
    };
  }
  return merged;
}
