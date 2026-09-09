import type { BindingClient } from "@kohaku-ui/data-binding";
import { BindingError } from "@kohaku-ui/data-binding";
import type { ComponentNode, TabularData, UISpec } from "@kohaku-ui/spec-core";
import { resolveBoundRef } from "@kohaku-ui/spec-core";
import type { RendererMessages } from "../messages.js";
import type { DataInvalidationBus } from "./invalidation-bus.js";
import type { SpecStateReadable } from "./spec-state-store.js";

export type BoundData =
  | { status: "idle" }
  | { status: "loading" }
  // dataVersion records that data newer than the Spec is being displayed after a post-write re-resolution.
  | { status: "ready"; data: TabularData; dataVersion?: string }
  | { status: "stale"; message: string }
  | { status: "error"; message: string };

/** A type narrowed to only the messages BoundDataController needs (bindingMissing / dataStale). */
export type BoundDataMessages = Pick<RendererMessages, "bindingMissing" | "dataStale">;

export interface BoundDataControllerDeps {
  /** The reference-resolution client. If unset, a node that has a ref becomes error (bindingMissing). */
  binding: BindingClient | undefined;
  /** The data-invalidation bus (the trigger for in-place re-resolution after a write). */
  bus: DataInvalidationBus;
  /** The $state used to re-resolve the effective ref. Reads the current value of values and its change notifications. */
  state: SpecStateReadable;
  messages: BoundDataMessages;
}

/**
 * The framework-free controller for reference-passing data resolution (the body
 * of useBoundData extracted out; the most important piece of A2).
 *
 * attach(node, spec, onChange) starts data resolution for a single node and pushes
 * BoundData to onChange (it synchronously pushes loading / idle / error on the
 * first pass, then asynchronously ready / stale / error after resolution). The
 * returned detach unsubscribes from $state / the bus. React's useBoundData IS a
 * thin wrapper that wraps this attach with useEffect + useState (its own
 * responsibility is limited to re-attach granularity and supplying $state as a
 * SpecStateReadable). WC's part builders call attach directly and swap the DOM in
 * onChange. → The parity of last-wins, invalidation, and freshness matching is
 * guaranteed here in one place.
 *
 * Semantics (matching use-bound-data.ts):
 * - Last-wins by an issue seq (independent of arrival order). Since the main path
 *   and bus re-resolution write the same onChange, we "apply only when we are the
 *   latest seq" so an old resolution does not overwrite a newer one.
 * - The normal matching target is spec.refVersions?.[ref] ?? (spec.dataVersion if
 *   ref === the raw $ref).
 * - Two-way binding: if data.bind exists, re-resolve the effective ref with
 *   the current $state. When a $state change alters the effective ref, re-run the
 *   main path. Freshness matching is done only for the initial variant
 *   (effectiveRef === the raw $ref); other variants derived from $state skip
 *   matching (to avoid a false STALE).
 * - The write loop: subscribe to invalidation of its own ref, match against the
 *   version in event.refVersions (skip matching if unknown), and refetch.
 */
export interface BoundDataAttachOptions {
  /**
   * When false, attach does no resolution and no subscription at all: it synchronously reports
   * {status:"idle"} once and returns a no-op detach. Default true.
   *
   * Exists for callers that have their own separate refetch state machine for the same node (e.g. a
   * serverSide presentSpreadsheet's SpreadsheetRemoteController) and must not let this controller's own
   * un-paged (full-dataset) resolution race that machine's paged one on every initial attach.
   */
  enabled?: boolean;
}

export interface BoundDataController {
  attach(
    node: ComponentNode,
    spec: UISpec,
    onChange: (data: BoundData) => void,
    options?: BoundDataAttachOptions,
  ): () => void;
}

/**
 * Freshness-matching target version for a resolved ref (shared by the controller
 * and any thin-wrapper hook that needs to key re-attachment off it by value): the
 * initial variant (ref === rawRef, the node's own raw $ref) matches
 * spec.refVersions?.[ref] ?? spec.dataVersion; another variant switched via
 * $state is not in refVersions, so matching is skipped (returns undefined).
 */
export function expectedVersionFor(
  spec: UISpec,
  ref: string,
  rawRef: string | undefined,
): string | undefined {
  return spec.refVersions?.[ref] ?? (ref === rawRef ? spec.dataVersion : undefined);
}

export function createBoundDataController(deps: BoundDataControllerDeps): BoundDataController {
  const { binding, bus, state, messages } = deps;

  return {
    attach(node, spec, onChange, options) {
      if (options?.enabled === false) {
        onChange({ status: "idle" });
        return () => {};
      }

      let active = true;
      // The issue sequence number (monotonically increasing). Because the main
      // path, $state re-resolution, and bus re-resolution all write the same
      // onChange, if response arrival order swaps, an old resolution could
      // overwrite a newer one. We stamp each resolution with a seq and limit
      // application to "only when we are the latest seq", making it last-wins
      // (independent of arrival order).
      let seq = 0;
      let currentRef: string | undefined;
      let busUnsub: (() => void) | undefined;

      const rawRef = node.data?.$ref;

      // The effective ref obtained by resolving data.bind with the current $state. Identical to the raw $ref when there is no binding / in the initial state.
      const computeRef = (): string | undefined =>
        node.data != null ? resolveBoundRef(node.data, state.values) : undefined;

      // Freshness matching: for the initial variant (effectiveRef === the raw
      // $ref), refVersions[ref] ?? dataVersion. Another variant switched via $state
      // is not in refVersions, so we set the matching target to undefined and skip
      // matching.
      const computeExpected = (ref: string): string | undefined => expectedVersionFor(spec, ref, rawRef);

      // Main path: match against the Spec-derived version and resolve (runs on ref change / initialization).
      const runMain = (ref: string | undefined): void => {
        if (ref == null) {
          seq++; // stale out any in-flight resolution (so the transition to idle is not overwritten by an old response)
          onChange({ status: "idle" });
          return;
        }
        if (binding == null) {
          seq++;
          onChange({ status: "error", message: messages.bindingMissing });
          return;
        }
        const mySeq = ++seq;
        onChange({ status: "loading" });
        resolveInto(binding, ref, computeExpected(ref), messages.dataStale, (next) => {
          if (active && mySeq === seq) onChange(next);
        });
      };

      // Re-attach the invalidation-bus subscription to the current ref (in-place re-resolution after a write).
      const resubscribeBus = (ref: string | undefined): void => {
        busUnsub?.();
        busUnsub = undefined;
        if (ref == null || binding == null) return;
        busUnsub = bus.subscribe(ref, (event) => {
          const exp = event.refVersions?.[ref]; // if unknown (undefined), skip matching
          const mySeq = ++seq;
          onChange({ status: "loading" });
          resolveInto(binding, ref, exp, messages.dataStale, (next) => {
            if (active && mySeq === seq) onChange(next);
          });
        });
      };

      const applyRef = (next: string | undefined): void => {
        currentRef = next;
        resubscribeBus(next);
        runMain(next);
      };

      // Initial resolution (synchronously pushes loading / idle / error).
      applyRef(computeRef());

      // When a $state change alters the effective ref, re-run the main path (equivalent to React's effect deps=[ref,...]).
      const stateUnsub = state.subscribe(() => {
        if (!active) return;
        const next = computeRef();
        if (next !== currentRef) applyRef(next);
      });

      return () => {
        active = false;
        stateUnsub();
        busUnsub?.();
      };
    },
  };
}

/** The common processing for binding.resolve (shared by the main path and re-resolution). The caller decides the matching-target version. */
function resolveInto(
  binding: BindingClient,
  ref: string,
  expected: string | undefined,
  staleMessage: string,
  set: (next: BoundData) => void,
): void {
  binding
    .resolve(ref, expected != null ? { expectedDataVersion: expected } : {})
    .then((data) => {
      set({
        status: "ready",
        data,
        ...(data.dataVersion != null ? { dataVersion: data.dataVersion } : {}),
      });
    })
    .catch((e: unknown) => {
      if (e instanceof BindingError && e.code === "STALE_VERSION") {
        set({ status: "stale", message: staleMessage });
      } else {
        set({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    });
}
