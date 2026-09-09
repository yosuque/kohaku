import type { JsonValue } from "@kohaku-ui/spec-core";

/**
 * The minimal interface that only reads $state (used by BoundDataController to
 * re-resolve the effective ref). values always returns the latest (swapped by set
 * / resetForIntent). subscribe notifies of changes.
 */
export interface SpecStateReadable {
  readonly values: Readonly<Record<string, JsonValue>>;
  /** Subscribe to value changes (set / resetForIntent). Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
}

/**
 * The client-local state store (the framework-free version of SpecStateProvider,
 * kohaku >= 0.2). The state is confined to the Renderer and never sent to the
 * server (the caller applies the state.set branch of resolveEmit).
 *
 * Its lifetime is tied to **intent.hash**:
 * - On a patch application (a spec swap for the same intent; a streaming
 *   skeleton → finalized form), the state is preserved.
 * - Only when intent.hash changes (a different screen) is it re-initialized from
 *   spec.state (resetForIntent).
 *
 * React's SpecStateProvider reflected hash changes synchronously by "following
 * props during render". WC gets the same semantics by calling
 * resetForIntent(spec.intent.hash, spec.state ?? {}) every time it receives a spec.
 */
export interface SpecStateStore extends SpecStateReadable {
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
  /**
   * Re-initializes with initialState when intent.hash changes. A no-op for the same
   * hash (values preserved). Pass the new spec's state (spec.state ?? {}) as
   * initialState.
   */
  resetForIntent(hash: string, initialState: Record<string, JsonValue>): void;
}

export function createSpecStateStore(
  initialHash: string,
  initialState: Record<string, JsonValue>,
): SpecStateStore {
  let hash = initialHash;
  // Like React's setValues({ ...prev, [key]: value }), swap in a new object
  // reference on every update (consistent with consumers that detect change by
  // reference equality). values always returns the latest via the getter.
  let values: Record<string, JsonValue> = { ...initialState };
  const listeners = new Set<() => void>();
  const notify = (): void => {
    // Iterate over a snapshot to guard against subscribe/unsubscribe during notification.
    for (const cb of [...listeners]) cb();
  };

  return {
    get values() {
      return values;
    },
    get: (key) => values[key],
    set: (key, value) => {
      values = { ...values, [key]: value };
      notify();
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    resetForIntent: (nextHash, nextInitial) => {
      if (nextHash === hash) return; // same intent is preserved (patch / streaming swap)
      hash = nextHash;
      values = { ...nextInitial };
      notify();
    },
  };
}
