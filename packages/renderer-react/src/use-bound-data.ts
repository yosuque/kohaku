import { type BoundData, createBoundDataController, expectedVersionFor } from "@kohaku-ui/renderer-core";
import { type ComponentNode, resolveBoundRef } from "@kohaku-ui/spec-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMessages, useRenderer, useSpec } from "./context.js";
import { useDataInvalidation } from "./data-invalidation.js";
import { useSpecStateReadable, useSpecStateSelector } from "./spec-state.js";

export type { BoundData };

export interface UseBoundDataOptions {
  /**
   * When false, the hook does not attach the controller at all — it stays at {status:"idle"} for as
   * long as it is disabled (see BoundDataController.attach's `enabled` branch). Default true.
   * PresentSpreadsheet passes `enabled: !(serverSide && snap.remoteActive)`: only while the
   * SpreadsheetRemoteController is *actually* the active fetch source (sortBy/pageSize declared, or the
   * user has interacted) would this hook's un-paged (full-dataset) base fetch otherwise fire
   * concurrently with the paged one, defeating the point of paging large datasets. A serverSide
   * spreadsheet that declares neither and hasn't been interacted with yet still relies on base for its
   * initial display, exactly like non-serverSide.
   */
  enabled?: boolean;
}

/**
 * Reference-passing data resolution hook. A thin wrapper over renderer-core's
 * BoundDataController (createBoundDataController / attach) — the same controller
 * WC's part builders call directly, guaranteeing last-wins / invalidation / freshness
 * matching are identical across renderers.
 *
 * What stays React-specific here is only:
 * - When to (re-)attach: value-based deps (the controller instance, the node's raw
 *   $ref, a JSON signature of data.bind, the Spec-derived expected version for
 *   the raw ref, and `enabled`). Deliberately NOT keyed on the effective ref (data.bind resolved
 *   against $state) or on node/spec object identity — the controller itself tracks
 *   $state changes internally (via the SpecStateReadable bridge below) and re-runs
 *   its own main path, so including the effective ref here would double-resolve on
 *   every $state-driven switch. And row templates hand this hook a freshly
 *   allocated node object on every render (resolveRowProps), so keying on node
 *   identity would re-attach (and loading-flash) on every unrelated re-render.
 * - Supplying $state to the controller as a SpecStateReadable, via the
 *   SpecStateProvider-scoped bridge (useSpecStateReadable), not the core
 *   createSpecStateStore + useSyncExternalStore store itself (see spec-state.tsx).
 */
export function useBoundData(node: ComponentNode, options?: UseBoundDataOptions): BoundData {
  const enabled = options?.enabled ?? true;
  const { binding } = useRenderer();
  const { bindingMissing, dataStale } = useMessages();
  const spec = useSpec();
  const bus = useDataInvalidation();
  const readable = useSpecStateReadable();

  const controller = useMemo(
    () =>
      createBoundDataController({
        binding,
        bus,
        state: readable,
        messages: { bindingMissing, dataStale },
      }),
    [binding, bus, readable, bindingMissing, dataStale],
  );

  const rawRef = node.data?.$ref;
  const bindSig = node.data?.bind != null ? JSON.stringify(node.data.bind) : "";
  // The effective ref, resolving data.bind with the current $state — used only to compute the
  // freshness-matching target below (rendered synchronously; it is NOT an attach dep, see the
  // hook-level docs above: the controller tracks $state-driven switches itself). Selectively
  // subscribed via useSpecStateSelector: this hook re-renders only when the *effective ref's
  // value* changes, not on every unrelated $state.set (a whole-`values` useSpecState() subscription
  // would instead re-render every data-bound node on any $state change).
  const ref = useSpecStateSelector((values) =>
    node.data != null ? resolveBoundRef(node.data, values) : undefined,
  );
  // Recomputed only when the Spec object changes (a value, not an identity dep below): re-attach
  // must track this by VALUE so that re-delivering an equal-content Spec (a new object, e.g. a
  // streaming patch or a same-content re-render) does not re-resolve.
  const expectedAtSpec = useMemo(
    () => (ref != null ? expectedVersionFor(spec, ref, rawRef) : undefined),
    // intentional: recompute ONLY when the Spec object is swapped (a real precedent for this pattern:
    // spreadsheet.tsx's own deliberate deps list). Do NOT add `ref` here — a $state-driven ref switch
    // must not retrigger this memo, since the controller already re-runs its main path for that switch
    // internally; adding `ref` would make expectedAtSpec change too and force a second, redundant
    // re-attach below (a double resolve), defeating the point of excluding the effective ref from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec],
  );

  const [state, setState] = useState<BoundData>({
    status: rawRef != null && enabled ? "loading" : "idle",
  });

  // The latest node/spec, read inside the effect at attach time (not as effect deps — see above).
  const latest = useRef({ node, spec });
  latest.current = { node, spec };

  useEffect(() => {
    const { node, spec } = latest.current;
    return controller.attach(node, spec, setState, { enabled });
    // rawRef / bindSig / expectedAtSpec / enabled are value-based re-attach keys (see hook docs); the
    // effective ref and node/spec identity are deliberately excluded.
  }, [controller, rawRef, bindSig, expectedAtSpec, enabled]);

  return state;
}
