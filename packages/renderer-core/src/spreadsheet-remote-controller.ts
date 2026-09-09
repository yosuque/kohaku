import type { BindingClient } from "@kohaku-ui/data-binding";
import { buildResolveOptions, type SortState } from "./presenters/spreadsheet.js";
import type { BoundData } from "./stores/bound-data-controller.js";
import type { DataInvalidationBus } from "./stores/invalidation-bus.js";

/**
 * A snapshot of the refetch state machine for a serverSide spreadsheet.
 * React / WC subscribe to it to render (they do not hold the same state in local
 * hooks / closures).
 */
export interface SpreadsheetRemoteSnapshot {
  sort: SortState | undefined;
  cursor: string | undefined;
  /** Whether the user has performed a sort/page operation. */
  interacted: boolean;
  /**
   * The result of the remote path. When null, the display comes from the base
   * (BoundData / useBoundData) side. Always null when inactive. When active,
   * loading → ready/error.
   */
  remote: BoundData | null;
  /** Whether the remote path is active due to a declaration (sortBy/pageSize) or a user operation. */
  remoteActive: boolean;
}

export interface SpreadsheetRemoteControllerDeps {
  /** The reference-resolution client. If unset, no refetching occurs. */
  binding: BindingClient | undefined;
  /** The write-invalidation bus (the trigger for a cursor reset + refetch). */
  bus: DataInvalidationBus;
  /**
   * The node's initial effective ref (data.bind resolved against $state at construction time). If
   * undefined, no refetching or invalidation subscription. Later changes (a $state-driven bind switch)
   * are tracked via setRef, not by re-constructing the controller.
   */
  ref: string | undefined;
  pageSize: number | undefined;
  /**
   * When false, does no refetching or invalidation subscription and only holds the
   * sort state (for serverSide=false local sorting).
   */
  serverSide: boolean;
  /** The initial sortBy declared by the Spec. */
  declaredSort: SortState | undefined;
}

/**
 * The refetch state machine for a serverSide spreadsheet (framework-free).
 *
 * The same "subscribe + snapshot" shape as BoundDataController. React consumes it
 * with subscribe → setState, WC with subscribe → rerender. The semantics of
 * last-wins (seq), invalidation, and sort/cursor/interacted are the single source
 * of truth here (unifying React's reloadNonce / WC's remoteToken).
 */
export interface SpreadsheetRemoteController {
  getSnapshot(): SpreadsheetRemoteSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Starts the initial refetch and the invalidation subscription. Returns a
   * teardown (for unmount / part disposal). Calling it multiple times just
   * re-attaches the previous subscription.
   */
  start(): () => void;
  /**
   * Tracks when node.props.sortBy changes "by value" on a Spec redelivery.
   * Compares by a serialized signature rather than reference equality; a no-op for
   * identical content. On change, resets cursor/interacted and refetches.
   */
  syncDeclaredSort(declared: SortState | undefined): void;
  toggleSort(colKey: string): void;
  goFirstPage(): void;
  goNextPage(next: string): void;
  /**
   * Tracks the node's **effective** ref (data.bind resolved against $state), not just the
   * declaration-time deps.ref. Compares by string equality; a no-op when unchanged. On change:
   * cursor resets (page position is scoped to a ref — a stale cursor from the previous variant is
   * meaningless against the new one), **interacted is intentionally left as-is** (a user's sort choice
   * is a display preference that should survive a filter/bind-driven ref switch, not just a paging
   * position), the invalidation-bus subscription is re-attached to the new ref, and — mirroring
   * syncDeclaredSort — a serverSide controller refetches under the new ref while a non-serverSide one
   * just notifies (local sort/paging has no ref to refetch against).
   */
  setRef(next: string | undefined): void;
}

export function createSpreadsheetRemoteController(
  deps: SpreadsheetRemoteControllerDeps,
): SpreadsheetRemoteController {
  const { binding, bus } = deps;
  let ref = deps.ref;
  const pageSize = deps.pageSize;
  const serverSide = deps.serverSide;

  let sort: SortState | undefined = deps.declaredSort;
  let cursor: string | undefined;
  let interacted = false;
  let remote: BoundData | null = null;
  // Whether a declared sortBy exists (from props; separate from the sort itself, which changes on operations).
  let hasDeclaredSort = deps.declaredSort != null;
  // The value signature of the declared sortBy (content comparison, not reference equality).
  let declaredSortSig = sigOf(deps.declaredSort);

  // The last-wins token (monotonically increasing). A delayed old response never overwrites a newer one.
  let seq = 0;
  let active = false;
  let busUnsub: (() => void) | undefined;

  const listeners = new Set<() => void>();

  const isRemoteActive = (): boolean => hasDeclaredSort || pageSize != null || interacted;

  function snapshot(): SpreadsheetRemoteSnapshot {
    return {
      sort,
      cursor,
      interacted,
      remote,
      remoteActive: isRemoteActive(),
    };
  }

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  /**
   * Remote refetch. When inactive, remote=null. When active, loading → resolve.
   * Advances seq on every call, so it re-runs even when cursor is already at the
   * first page (equivalent to the old reloadNonce).
   */
  function refetch(): void {
    if (!serverSide || ref == null || binding == null) return;
    if (!isRemoteActive()) {
      seq++; // stale out any in-flight resolution
      remote = null;
      notify();
      return;
    }
    const my = ++seq;
    remote = { status: "loading" };
    notify();
    binding
      .resolve(ref, buildResolveOptions(sort, cursor, pageSize))
      .then((data) => {
        if (active && my === seq) {
          remote = { status: "ready", data };
          notify();
        }
      })
      .catch((e: unknown) => {
        if (active && my === seq) {
          remote = { status: "error", message: e instanceof Error ? e.message : String(e) };
          notify();
        }
      });
  }

  function resubscribeBus(): void {
    busUnsub?.();
    busUnsub = undefined;
    // Subscribe when serverSide + ref exist. For an inactive invalidation, refetch
    // just sets remote=null (the display is separately re-resolved by the base-side
    // BoundDataController / useBoundData).
    if (!serverSide || ref == null || binding == null) return;
    busUnsub = bus.subscribe(ref, () => {
      // After a write, the version-signed cursor becomes invalid, so go back to the first page (keep the sort).
      cursor = undefined;
      refetch();
    });
  }

  return {
    getSnapshot: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      active = true;
      resubscribeBus();
      if (serverSide) refetch();
      return () => {
        active = false;
        seq++; // stale out any in-flight resolution
        busUnsub?.();
        busUnsub = undefined;
      };
    },

    syncDeclaredSort(declared) {
      const nextSig = sigOf(declared);
      if (nextSig === declaredSortSig) return;
      declaredSortSig = nextSig;
      hasDeclaredSort = declared != null;
      sort = declared;
      cursor = undefined;
      interacted = false;
      if (serverSide) refetch();
      else notify();
    },

    toggleSort(colKey) {
      sort = {
        field: colKey,
        dir: sort?.field === colKey && sort.dir === "desc" ? "asc" : "desc",
      };
      if (serverSide) {
        cursor = undefined;
        interacted = true;
        refetch();
      } else {
        notify();
      }
    },

    goFirstPage() {
      cursor = undefined;
      interacted = true;
      refetch();
    },

    goNextPage(next) {
      cursor = next;
      interacted = true;
      refetch();
    },

    setRef(next) {
      if (next === ref) return;
      ref = next;
      cursor = undefined;
      // interacted is deliberately left unchanged — see the interface doc above.
      seq++; // stale out any in-flight resolution tied to the old ref
      resubscribeBus();
      if (serverSide) refetch();
      else notify();
    },
  };
}

function sigOf(declared: SortState | undefined): string {
  return declared != null ? JSON.stringify(declared) : "";
}
