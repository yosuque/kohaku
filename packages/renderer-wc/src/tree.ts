import type { BindingClient } from "@kohaku-ui/data-binding";
import {
  createBoundDataController,
  type DataInvalidationBus,
  type RendererMessages,
  resolveEmit,
  resolveInvokeTarget,
  resolveRowProps,
  resolveSizing,
  resolveToken,
  runInvokeTarget,
  type SpecStateStore,
  type SurfaceEvent,
} from "@kohaku-ui/renderer-core";
import {
  type ComponentNode,
  evaluateVisibleWhen,
  type JsonObject,
  SANDBOX_HTML_TYPE,
  type ThemeTokens,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { nodeNotice, noop } from "./dom.js";
import { mountSandboxNode } from "./sandbox-mount.js";
import type { ActionPhase, PartBuilder, RenderRuntime, SurfaceContext, Teardown } from "./types.js";

export interface RuntimeDeps {
  spec: UISpec;
  store: SpecStateStore;
  bus: DataInvalidationBus;
  theme: ThemeTokens;
  locale: string;
  messages: RendererMessages;
  ctx: SurfaceContext;
  registry: Map<string, PartBuilder>;
  /** Upstream notification of a forward event (CustomEvent dispatch; the onEvent call is done by the glue inside this). */
  dispatchForward(event: SurfaceEvent): void;
}

/**
 * Assembles a RenderRuntime scoped to a single Spec render. mountNode/mountChildren, etc. are closures
 * that reference rt, so the part builders (parts/*) can recurse via rt without importing tree.ts
 * (avoiding an import cycle).
 */
export function createRuntime(deps: RuntimeDeps): RenderRuntime {
  const byId = new Map(deps.spec.components.map((c) => [c.id, c]));
  const controller = createBoundDataController({
    binding: deps.ctx.binding,
    bus: deps.bus,
    state: deps.store,
    messages: deps.messages,
  });

  const rt: RenderRuntime = {
    spec: deps.spec,
    byId,
    store: deps.store,
    bus: deps.bus,
    controller,
    binding: deps.ctx.binding,
    theme: deps.theme,
    sizing: resolveSizing(deps.theme),
    locale: deps.locale,
    messages: deps.messages,
    onNodeError: deps.ctx.onNodeError,
    onActionResult: deps.ctx.onActionResult,
    sandbox: deps.ctx.sandbox,
    registry: deps.registry,
    dispatchForward: deps.dispatchForward,

    mountNode: (parent, id, row) => mountNode(rt, parent, id, row),
    mountChildren: (parent, childIds, row) => mountChildren(rt, parent, childIds, row),
    mountSandbox: (parent, node) => mountSandboxNode(rt, parent, node),

    emit: (node, eventName, runtime, row) => emitEvent(rt, node, eventName, runtime, row),
    invoke: (node, eventName, runtime, row, onPhase) =>
      invokeAction(rt, node, eventName, runtime, row, onPhase),
  };
  return rt;
}

/** Builds the entire tree into parent via DFS from the root. The return value can tear down the whole tree. */
export function mountTree(rt: RenderRuntime, parent: ParentNode, rootId: string): Teardown {
  return mountNode(rt, parent, rootId, null);
}

function mountChildren(
  rt: RenderRuntime,
  parent: ParentNode,
  childIds: string[] | undefined,
  row: JsonObject | null,
): Teardown {
  if (childIds == null || childIds.length === 0) return noop;
  const teardowns = childIds.map((id) => mountNode(rt, parent, id, row));
  return () => {
    for (const t of teardowns) t();
  };
}

function mountNode(rt: RenderRuntime, parent: ParentNode, id: string, row: JsonObject | null): Teardown {
  const rawNode = rt.byId.get(id);
  if (rawNode == null) return noop;
  if (rawNode.visibleWhen != null) return mountReactiveVisible(rt, parent, rawNode, row);
  return mountVisibleNode(rt, parent, rawNode, row);
}

/**
 * Reactive slot for nodes that have visibleWhen. Places an anchor comment and, on every $state change, re-evaluates
 * the condition to mount / unmount the subtree (same semantics as renderer-react's NodeView conditional display = subtree unmount).
 */
function mountReactiveVisible(
  rt: RenderRuntime,
  parent: ParentNode,
  rawNode: ComponentNode,
  row: JsonObject | null,
): Teardown {
  const anchor = document.createComment(`kohaku:vw:${rawNode.id}`);
  parent.appendChild(anchor);
  let inner: Teardown | null = null;

  const evalVisible = (): void => {
    const visible = evaluateVisibleWhen(rawNode.visibleWhen!, rt.store.values);
    if (visible && inner == null) {
      // Build in a detached container first, then move it right after the anchor (preserves sibling order).
      const holder = document.createElement("div");
      const teardown = mountVisibleNode(rt, holder, rawNode, row);
      const inserted = [...holder.childNodes];
      let ref: ChildNode = anchor;
      for (const n of inserted) {
        ref.after(n);
        ref = n;
      }
      inner = () => {
        teardown();
        for (const n of inserted) n.remove();
      };
    } else if (!visible && inner != null) {
      inner();
      inner = null;
    }
  };

  evalVisible();
  const unsub = rt.store.subscribe(evalVisible);
  return () => {
    unsub();
    inner?.();
    anchor.remove();
  };
}

/** Builds a single display-confirmed node (row-template substitution + per-node try/catch → fallback notice). */
function mountVisibleNode(
  rt: RenderRuntime,
  parent: ParentNode,
  rawNode: ComponentNode,
  row: JsonObject | null,
): Teardown {
  // Row-template mechanism (presentList): if there is a row context, substitute props' "$row.<column>" with that row's value.
  const node = row != null ? resolveRowProps(rawNode, row) : rawNode;
  try {
    if (node.type === SANDBOX_HTML_TYPE) {
      return rt.mountSandbox(parent, node);
    }
    const builder = rt.registry.get(node.type);
    if (builder == null) {
      parent.appendChild(
        nodeNotice(
          `Unimplemented component type: ${node.type}`,
          String(resolveToken(rt.theme, "color.negative.text")),
          rt.sizing,
        ),
      );
      return noop;
    }
    return builder(rt, parent, node, row);
  } catch (error) {
    // Isolate a single node's render exception and keep siblings / the whole surface alive (equivalent to NodeErrorBoundary).
    rt.onNodeError?.({ componentId: node.id, componentType: node.type, error });
    parent.appendChild(
      nodeNotice(
        rt.messages.nodeRenderFailed(node.type, node.id),
        String(resolveToken(rt.theme, "color.negative.text")),
        rt.sizing,
      ),
    );
    return noop;
  }
}

/**
 * Applies event-emission governance (the glue for resolveEmit). Sink presence is not decided in resolveEmit;
 * here (the glue) dispatchForward handles both the CustomEvent and onEvent.
 */
function emitEvent(
  rt: RenderRuntime,
  node: ComponentNode,
  eventName: string,
  runtime: JsonObject,
  row: JsonObject | null,
): void {
  const res = resolveEmit(rt.spec, node, eventName, runtime, row);
  if (res.kind === "state.set") {
    rt.store.set(res.key, res.value);
  } else if (res.kind === "forward") {
    rt.dispatchForward(res.event);
  }
  // drop: undeclared events are discarded (SPEC-EVT-002).
}

/**
 * Applies the write path (the glue for resolveInvokeTarget). Whether binding exists is passed as a boolean.
 * For invoke, delegates the pending/invokeAction/phase/publish/onActionResult sequence to renderer-core's
 * runInvokeTarget (shared with renderer-react); otherwise delegates to emit.
 */
async function invokeAction(
  rt: RenderRuntime,
  node: ComponentNode,
  eventName: string,
  runtime: JsonObject,
  row: JsonObject | null,
  onPhase: (phase: ActionPhase) => void,
): Promise<void> {
  const target = resolveInvokeTarget(rt.spec, node, eventName, runtime, {
    hasBinding: rt.binding != null,
    row,
  });
  if (target.kind === "forward") {
    emitEvent(rt, node, eventName, runtime, row);
    return;
  }
  const binding = rt.binding as BindingClient;
  // The pending → invokeAction → succeeded/failed phase → bus.publish → onActionResult sequence has
  // renderer-core's runInvokeTarget as the single source of truth (shared with renderer-react).
  await runInvokeTarget(
    target,
    { binding, bus: rt.bus, onActionResult: rt.onActionResult },
    node.id,
    onPhase,
  );
}
