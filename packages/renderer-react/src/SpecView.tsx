import {
  type ComponentNode,
  evaluateVisibleWhen,
  ROOT_COMPONENT_ID,
  SANDBOX_HTML_TYPE,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { memo, type ReactNode, useMemo, ViewTransition } from "react";
import { resolveRowProps, SpecProvider, useMessages, useRenderer, useToken } from "./context.js";
import { NodeErrorBoundary } from "./node-error-boundary.js";
import { SpecStateProvider, useRowContext, useSpecStateSelector } from "./spec-state.js";

export interface SpecViewProps {
  spec: UISpec;
  /**
   * Opt-in: cross-fade a Spec *swap* with React 19.3's stable `<ViewTransition>` (react/index.d.ts,
   * `@version 19.3.0`) instead of popping in place. Default false — with the prop omitted, SpecTree
   * renders directly with no `<ViewTransition>` in the tree at all, so DOM output is byte-identical to
   * the pre-View-Transition renderer (verified by the React/WC parity corpus, which never passes this
   * prop and must keep asserting semantic DOM equivalence).
   *
   * What counts as a "swap": `<ViewTransition>` is keyed on `transitionKeyFor(spec)` (tier + composed
   * intent), so it only remounts — and thus only plays an enter/exit transition — at the moments
   * docs/design.md calls out as swaps: an L0 fixed Spec giving way to an L1 generated one (tier flips),
   * and a drill-down composing a different intent. It deliberately stays mounted across a single
   * generation's skeleton → provisional patches → final patch: compose-stream.ts throttles provisional
   * patches to ~60ms and keeps `provenance.tier` and `intent` fixed for the whole generation, only
   * `components`/`state` differ patch to patch, so those updates reconcile in place under the same key
   * and can never themselves force the cross-fade.
   *
   * Even with the key stable, React only actually plays a transition for an update that is itself
   * scheduled via startTransition / useDeferredValue / an Action / a Suspense reveal — a plain
   * synchronous setState is the documented opt-out (see the `<ViewTransition>` doc comment in
   * react/index.d.ts). SpecView does not own the top-level Spec state (useSpecStream / the host app
   * does), so it cannot itself decide which update is transition-worthy: a caller that wants a swap
   * animated must wrap that specific setSpec call in startTransition, while frequent provisional-patch
   * updates should stay plain synchronous setState so they never trigger a transition even if a browser
   * supports the View Transition API. Either way, jsdom and browsers without the View Transition API
   * render exactly as before with no error — React itself falls back to committing the update
   * immediately (react-dom-client's startViewTransition wraps `document.startViewTransition(...)` in a
   * try/catch and falls through to a plain commit when the browser has no such API).
   */
  enableViewTransitions?: boolean;
}

/**
 * Resolves a UI Spec → React tree. Recursively renders a flat list + ID references from the root.
 * The uniqueness of Spec interpretation (a Renderer-layer responsibility) is guaranteed here.
 *
 * Always wrap SpecStateProvider inside SpecProvider so visibleWhen evaluation and state.set are
 * completed inside the Renderer (client-local state — kohaku >= 0.2). SpecStateProvider wraps (is not
 * wrapped by) the optional ViewTransition boundary so that a swap's cross-fade never discards
 * client-local $state — only the rendered DOM subtree remounts.
 */
export function SpecView({ spec, enableViewTransitions = false }: SpecViewProps): ReactNode {
  return (
    <SpecProvider spec={spec}>
      <SpecStateProvider spec={spec}>
        {enableViewTransitions ? (
          <ViewTransition key={transitionKeyFor(spec)}>
            <SpecTree spec={spec} />
          </ViewTransition>
        ) : (
          <SpecTree spec={spec} />
        )}
      </SpecStateProvider>
    </SpecProvider>
  );
}

/** See SpecViewProps.enableViewTransitions for the reasoning behind this identity. */
function transitionKeyFor(spec: UISpec): string {
  return `${spec.provenance.tier}:${spec.intent.canonical}`;
}

function SpecTree({ spec }: { spec: UISpec }): ReactNode {
  const byId = useMemo(() => new Map(spec.components.map((c) => [c.id, c])), [spec.components]);
  return <NodeView spec={spec} byId={byId} id={ROOT_COMPONENT_ID} />;
}

/**
 * memo()'d so a parent re-render (e.g. a sibling's visibleWhen flipping, which re-renders the shared
 * parent NodeView) does not, by itself, re-render every child NodeView — spec/byId/id are all
 * referentially stable across a $state-only update (see the module doc above), so the default shallow
 * comparison is sufficient. Combined with useSpecStateSelector below (which stops a $state change from
 * even reaching a node that has nothing to react to), a node only re-renders for its own reasons.
 */
const NodeView = memo(function NodeView({
  spec,
  byId,
  id,
}: {
  spec: UISpec;
  byId: Map<string, ComponentNode>;
  id: string;
}): ReactNode {
  const { impls, renderSandbox, onNodeError } = useRenderer();
  const messages = useMessages();
  const row = useRowContext();
  const rawNode = byId.get(id);

  // Selective $state subscription (useSpecStateSelector, built on useSyncExternalStore): a node
  // without visibleWhen selects the constant `true`, so it never re-renders from a $state change at
  // all — only nodes that actually declare visibleWhen react, and only when their own evaluated result
  // flips (not on every unrelated $state key changing). This is what keeps a single $state.set from
  // re-rendering the whole tree instead of every NodeView subscribing to the full `values` object via
  // useSpecState(). data.bind-driven components remain reactive independently through their own
  // useBoundData subscription, which is unaffected by this hook.
  const visible = useSpecStateSelector((values) =>
    rawNode?.visibleWhen != null ? evaluateVisibleWhen(rawNode.visibleWhen, values) : true,
  );

  if (rawNode == null) return null;

  // Conditional display (kohaku >= 0.2): if visibleWhen is false, do not render the whole subtree (unmount).
  // A hidden component's useBoundData does not run (= lazy loading of unselected tabs). Because of unmount,
  // while hidden, the local state held by that component tree (spreadsheet sorting etc.) is lost.
  // visibleWhen references $state, so evaluate it on the pre-row-template-substitution rawNode (independent of $row).
  if (!visible) {
    return null;
  }

  // Row template mechanism (presentList): if a row context exists, substitute props' "$row.<column name>" with that row's value.
  // Substitution is centralized here in NodeView alone; component implementations are unaware of the mechanism.
  const node = row != null ? resolveRowProps(rawNode, row) : rawNode;

  // Fallback and notification when an exception is thrown during node rendering. Key on node so that
  // the error boundary can retry when the Spec is swapped.
  const fallback = (): ReactNode => <NodeNotice message={messages.nodeRenderFailed(node.type, node.id)} />;
  const handleError = (error: unknown): void =>
    onNodeError?.({ componentId: node.id, componentType: node.type, error });

  if (node.type === SANDBOX_HTML_TYPE) {
    if (renderSandbox != null) {
      return (
        <NodeErrorBoundary node={node} fallback={fallback} onError={handleError}>
          {renderSandbox(node, spec)}
        </NodeErrorBoundary>
      );
    }
    return (
      <NodeNotice
        message={`Rendering the L2 component (${SANDBOX_HTML_TYPE}) requires injecting the sandbox renderer`}
      />
    );
  }

  const Impl = impls.get(node.type);
  if (Impl == null) {
    return <NodeNotice message={`Unimplemented component type: ${node.type}`} />;
  }

  const children =
    node.children != null && node.children.length > 0
      ? node.children.map((childId) => <NodeView key={childId} spec={spec} byId={byId} id={childId} />)
      : undefined;

  return (
    <NodeErrorBoundary node={node} fallback={fallback} onError={handleError}>
      <Impl node={node}>{children}</Impl>
    </NodeErrorBoundary>
  );
});

/**
 * Generic placeholder shown when a component cannot be rendered (unimplemented type / sandbox not injected /
 * render-failure fallback). Stands out with a dashed border while not breaking the surrounding rendering.
 */
function NodeNotice({ message }: { message: string }): ReactNode {
  // Highlight the render-failure note with an error color (color.negative.text).
  const noticeColor = String(useToken("color.negative.text"));
  return (
    <div
      role="note"
      style={{
        border: `1px dashed ${noticeColor}`,
        color: noticeColor,
        borderRadius: 6,
        padding: "8px 12px",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
}
