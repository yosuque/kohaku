import type { SpecStateReadable } from "@kohaku-ui/renderer-core";
import type { JsonObject, JsonValue, UISpec } from "@kohaku-ui/spec-core";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Client-local state (kohaku >= 0.2). SpecView always wraps this internally (inside SpecProvider).
 * The state is confined to the Renderer and not sent to the server (state.set is completed here by useEmitEvent).
 */
export interface SpecStateApi {
  /** The current state value map (used for evaluating visibleWhen). */
  values: Record<string, JsonValue>;
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
}

const SpecStateContext = createContext<SpecStateApi | null>(null);

/** The setter-only slice of SpecStateApi (see useSpecStateActions below). */
export interface SpecStateActions {
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
}

/**
 * A stable-reference Context exposing only $state's actions (get/set), not its current `values`.
 * A caller that only ever writes to $state (useEmitEvent's state.set — see context.tsx) has no
 * reason to read `values`, so subscribing to it via useSpecState() re-renders on every unrelated
 * $state.set. The object handed out here is created once (via a ref) and never changes identity
 * for the Provider's lifetime, so useContext(SpecStateActionsContext) never itself triggers a
 * re-render — `set` closes over the always-stable setState function, and `get` reads through the
 * same valuesRef the SpecStateReadable bridge uses (see createReadableBridge below).
 */
const SpecStateActionsContext = createContext<SpecStateActions | null>(null);

/**
 * A minimal Context-facing bridge from SpecStateProvider's useState-backed values
 * to renderer-core's SpecStateReadable (the interface BoundDataController reads
 * $state through). It does not switch the state's storage to a core store —
 * SpecStateProvider's useState + synchronous intent-hash reset stays the single
 * source of truth. The bridge only re-exposes the latest `values` and notifies
 * subscribers after commit (from a useEffect keyed on `values`), i.e. at the same
 * phase useBoundData's own effect used to re-run on a $state change — so timing
 * is unchanged for controller consumers.
 */
const SpecStateReadableContext = createContext<SpecStateReadable | null>(null);

interface ReadableBridge {
  readable: SpecStateReadable;
  notify(): void;
}

function createReadableBridge(valuesRef: { current: Record<string, JsonValue> }): ReadableBridge {
  const listeners = new Set<() => void>();
  return {
    readable: {
      get values() {
        return valuesRef.current;
      },
      subscribe(cb) {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    notify() {
      // Iterate over a snapshot to guard against subscribe/unsubscribe during notification.
      for (const cb of [...listeners]) cb();
    },
  };
}

/**
 * The state's lifetime is tied to the **intent.hash**.
 * - On patch application (same-intent spec swap, streaming skeleton→finalized form), the state is preserved.
 * - Only when intent.hash changes (a different screen) is it re-initialized from spec.state.
 *
 * Re-initialization is done synchronously during render (React's official "adjust state on prop change" pattern).
 * A useEffect-based reset would, for just one frame right after an intent switch, evaluate visibleWhen with the old state,
 * causing a momentary flicker of hidden components to be missed, so avoid that.
 */
export function SpecStateProvider(props: { spec: UISpec; children: ReactNode }): ReactNode {
  const initial = props.spec.state ?? {};
  const [values, setValues] = useState<Record<string, JsonValue>>(() => ({ ...initial }));
  const trackedIntent = useRef(props.spec.intent.hash);

  if (trackedIntent.current !== props.spec.intent.hash) {
    trackedIntent.current = props.spec.intent.hash;
    setValues({ ...initial });
  }

  // The SpecStateReadable bridge: valuesRef always tracks the latest values (kept current on every
  // render, including the synchronous intent reset above), and bridge identity is stable for the
  // Provider's lifetime (created once via a ref).
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const bridgeRef = useRef<ReadableBridge | null>(null);
  bridgeRef.current ??= createReadableBridge(valuesRef);

  // Notify after commit (mirrors the phase useBoundData's main-path effect used to re-run on a $state change).
  useEffect(() => {
    bridgeRef.current!.notify();
  }, [values]);

  const api = useMemo<SpecStateApi>(
    () => ({
      values,
      get: (key) => values[key],
      set: (key, value) => setValues((prev) => ({ ...prev, [key]: value })),
    }),
    [values],
  );

  // The actions-only object (get/set), stable for the Provider's lifetime (created once via a ref,
  // mirroring bridgeRef above) — see SpecStateActionsContext's doc comment.
  const actionsRef = useRef<SpecStateActions | null>(null);
  actionsRef.current ??= {
    get: (key) => valuesRef.current[key],
    set: (key, value) => setValues((prev) => ({ ...prev, [key]: value })),
  };

  return (
    <SpecStateContext.Provider value={api}>
      <SpecStateActionsContext.Provider value={actionsRef.current}>
        <SpecStateReadableContext.Provider value={bridgeRef.current.readable}>
          {props.children}
        </SpecStateReadableContext.Provider>
      </SpecStateActionsContext.Provider>
    </SpecStateContext.Provider>
  );
}

export function useSpecState(): SpecStateApi {
  const ctx = useContext(SpecStateContext);
  if (ctx == null) throw new Error("useSpecState must be used inside <SpecView>");
  return ctx;
}

/**
 * The stable-reference actions-only view of $state (get/set, no `values`) — see
 * SpecStateActionsContext's doc comment. Prefer this over useSpecState() for a caller that only ever
 * writes (useEmitEvent's state.set): subscribing to the full SpecStateApi via useContext re-renders on
 * every $state.set even when the caller never reads `values`.
 */
export function useSpecStateActions(): SpecStateActions {
  const ctx = useContext(SpecStateActionsContext);
  if (ctx == null) throw new Error("useSpecStateActions must be used inside <SpecView>");
  return ctx;
}

/**
 * The framework-free read view of the current SpecStateProvider's $state (renderer-core's
 * SpecStateReadable), for handing to createBoundDataController. Unlike useSpecState, it exposes no
 * setter — BoundDataController only ever reads $state to compute the effective ref.
 */
export function useSpecStateReadable(): SpecStateReadable {
  const ctx = useContext(SpecStateReadableContext);
  if (ctx == null) throw new Error("useSpecStateReadable must be used inside <SpecView>");
  return ctx;
}

/**
 * Selective $state subscription built on useSyncExternalStore over the SpecStateReadable bridge
 * (the same source useSpecStateReadable exposes, so notification timing matches BoundDataController's
 * — see the bridge's doc comment above). Unlike useSpecState() (which subscribes via useContext to
 * *every* value change, re-rendering on any $state update), this only re-renders when `selector`'s
 * *return value* changes (useSyncExternalStore's Object.is bailout on the snapshot). Call it
 * unconditionally (Rules of Hooks) with a selector that returns a constant when a node has nothing to
 * react to — e.g. NodeView's visibleWhen evaluation returns `true` for a node with no visibleWhen, so
 * that node never re-renders from a $state change at all.
 */
export function useSpecStateSelector<T>(selector: (values: Record<string, JsonValue>) => T): T {
  const readable = useSpecStateReadable();
  return useSyncExternalStore(readable.subscribe, () => selector(readable.values));
}

/**
 * The row context of the row template mechanism (presentList, kohaku >= 0.2).
 * presentList sets up one Provider per row via rows.map, and the inner NodeView / useEmitEvent read the current row.
 * When non-null, NodeView substitutes props' "$row.<column name>" with that row's value (resolveRowProps).
 * When nested, the inner (nearest Provider's) row takes priority — $row has no parent-row access syntax.
 */
const RowContext = createContext<JsonObject | null>(null);

export function RowProvider(props: { row: JsonObject; children: ReactNode }): ReactNode {
  return <RowContext.Provider value={props.row}>{props.children}</RowContext.Provider>;
}

/** The current row context (inside a presentList template). Outside a row template, null. */
export function useRowContext(): JsonObject | null {
  return useContext(RowContext);
}
