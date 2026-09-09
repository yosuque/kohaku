import type { BindingClient } from "@kohaku-ui/data-binding";
import type { DataInvalidationBus } from "@kohaku-ui/renderer-core";
import {
  createSpreadsheetRemoteController,
  type SortState,
  type SpreadsheetRemoteController,
  type SpreadsheetRemoteSnapshot,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode } from "@kohaku-ui/spec-core";
import { useEffect, useMemo, useRef, useState } from "react";

export interface UseSpreadsheetRemoteOptions {
  /** The reference-resolution client (undefined disables remote refetching). */
  binding: BindingClient | undefined;
  /** The write-invalidation bus (the trigger for a cursor reset + refetch). */
  bus: DataInvalidationBus;
  /** props.serverSide (opt-in): when true, sorting/paging re-fetches via binding.resolve. */
  serverSide: boolean;
  /** props.pageSize. */
  pageSize: number | undefined;
  /**
   * The node's **effective** ref (data.bind resolved against the current $state; identical to the raw
   * $ref when there is no binding). When this changes — e.g. a sibling filter control updates $state —
   * the controller's own sort/page/invalidation-subscription follow it via setRef, instead of the
   * refetch snapping back to the ref that was current when the controller was constructed.
   */
  effectiveRef: string | undefined;
}

export interface UseSpreadsheetRemoteResult {
  ctrl: SpreadsheetRemoteController;
  snap: SpreadsheetRemoteSnapshot;
}

/**
 * React binding for renderer-core's SpreadsheetRemoteController (the framework-free
 * serverSide refetch state machine — the same "subscribe + snapshot" shape as
 * useBoundData wrapping BoundDataController; see use-bound-data.ts). Kept separate from
 * PresentSpreadsheet so that component's body is derivation + JSX only.
 *
 * Hook call order and effect/memo dependency arrays are intentionally fixed
 * (do not merge or split effects; do not add `ref`/`declaredSort` to
 * the controller useMemo deps — see the inline comments below and the
 * sortBy-content-change test in spreadsheet-serverside.test.tsx, which pins the "identical content does not
 * refetch" behavior).
 */
export function useSpreadsheetRemote(
  node: ComponentNode,
  { binding, bus, serverSide, pageSize, effectiveRef }: UseSpreadsheetRemoteOptions,
): UseSpreadsheetRemoteResult {
  const ref = node.data?.$ref;
  // In-column sorting is an "operation that does not change intent," so it is local state.
  const declaredSort = node.props["sortBy"] as unknown as SortState | undefined;

  // The serverSide re-fetch state machine has renderer-core's controller as the single source of truth.
  // declaredSort is passed only as the initial value; subsequent Spec re-delivery is tracked via syncDeclaredSort.
  const ctrl = useMemo(
    () =>
      createSpreadsheetRemoteController({
        binding,
        bus,
        ref,
        pageSize,
        serverSide,
        declaredSort,
      }),
    // declaredSort is tracked via syncDeclaredSort, so it is not included in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
    [binding, bus, ref, pageSize, serverSide],
  );

  const [snap, setSnap] = useState<SpreadsheetRemoteSnapshot>(() => ctrl.getSnapshot());

  // When node.props.sortBy changes "as a value" via Spec re-delivery, make the controller follow it
  // (the same "prop tracking during render" pattern as SpecStateProvider). Compare deeply by serialized signature, not reference equality.
  const declaredSortSig = declaredSort != null ? JSON.stringify(declaredSort) : "";
  const trackedSortSig = useRef(declaredSortSig);
  const trackedCtrl = useRef(ctrl);
  if (trackedCtrl.current !== ctrl) {
    // On controller regeneration the initial declaredSort is already applied, so just align the signature.
    trackedCtrl.current = ctrl;
    trackedSortSig.current = declaredSortSig;
    setSnap(ctrl.getSnapshot());
  } else if (trackedSortSig.current !== declaredSortSig) {
    trackedSortSig.current = declaredSortSig;
    ctrl.syncDeclaredSort(declaredSort);
    setSnap(ctrl.getSnapshot());
  }

  useEffect(() => {
    setSnap(ctrl.getSnapshot());
    const unsub = ctrl.subscribe(() => setSnap(ctrl.getSnapshot()));
    const stop = ctrl.start();
    return () => {
      unsub();
      stop();
    };
  }, [ctrl]);

  // Keep the controller's ref following a $state-driven data.bind switch (a sibling filter control
  // changing $state, e.g.), so sort/page refetches target the currently effective ref rather than
  // snapping back to the ref that was current when the controller was constructed. Deliberately a
  // separate effect from the controller useMemo above — do NOT add effectiveRef to that memo's deps
  // (see the comment there): recreating the controller on every $state-driven ref switch would drop
  // its sort/cursor/interacted state, exactly what setRef exists to avoid.
  useEffect(() => {
    ctrl.setRef(effectiveRef);
  }, [ctrl, effectiveRef]);

  return { ctrl, snap };
}
