/**
 * A data-invalidation event. Published on a successful write (action.invoke); the
 * BoundDataController subscribed to the relevant ref re-resolves in place (the
 * small loop).
 */
export interface DataInvalidationEvent {
  /** The `query://` URIs to invalidate (exact match). */
  refs: string[];
  /** The new per-reference data version (consistent with per-reference matching). The matching target on re-resolution. */
  refVersions?: Record<string, string>;
}

/**
 * A synchronous emitter that reaches even distant subtrees via per-ref
 * subscriptions. The framework-free source of truth (renderer-react's
 * DataInvalidationContext wrapper merely distributes this emitter through context).
 */
export interface DataInvalidationBus {
  publish(event: DataInvalidationEvent): void;
  /** Subscribe to invalidation of the given ref. Returns an unsubscribe function. */
  subscribe(ref: string, cb: (event: DataInvalidationEvent) => void): () => void;
}

/** A simple synchronous emitter of ref → set of subscribers. */
export function createDataInvalidationBus(): DataInvalidationBus {
  const subscribers = new Map<string, Set<(event: DataInvalidationEvent) => void>>();
  return {
    publish(event) {
      for (const ref of event.refs) {
        const set = subscribers.get(ref);
        // Iterate over a snapshot to guard against subscribe/unsubscribe during iteration.
        if (set != null) for (const cb of [...set]) cb(event);
      }
    },
    subscribe(ref, cb) {
      let set = subscribers.get(ref);
      if (set == null) {
        set = new Set();
        subscribers.set(ref, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) subscribers.delete(ref);
      };
    },
  };
}

/** A no-op bus that does not fail even in environments with no Provider / bus wired up (e.g. unit tests). */
export const NOOP_INVALIDATION_BUS: DataInvalidationBus = {
  publish() {},
  subscribe() {
    return () => {};
  },
};
