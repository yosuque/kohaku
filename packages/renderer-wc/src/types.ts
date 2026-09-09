import type { BindingClient } from "@kohaku-ui/data-binding";
import type {
  ActionPhase,
  BoundDataController,
  DataInvalidationBus,
  RendererMessages,
  SpecStateStore,
  SurfaceEvent,
} from "@kohaku-ui/renderer-core";
import type { SandboxBridge, SandboxPolicy } from "@kohaku-ui/sandbox";
import type { ComponentNode, JsonObject, ThemeTokens, UISpec } from "@kohaku-ui/spec-core";

export type { ActionPhase, SurfaceEvent } from "@kohaku-ui/renderer-core";

/** Teardown function (unsubscribe / controller detach / sandbox destroy, etc.). */
export type Teardown = () => void;

/**
 * Context passed to <kohaku-surface> as properties. Corresponds to React's RendererContextValue.
 * binding / theme / messages / onEvent, etc. are received as properties (objects/functions).
 */
export interface SurfaceContext {
  /** Reference-resolution client. If unset, parts that carry data become a bindingMissing error. */
  binding?: BindingClient;
  /** Theme tokens. Inline expansion for pixel-match; :host CSS variables as the external override point. */
  theme?: ThemeTokens;
  /** Display language tag (default "en-US", see renderer-core's DEFAULT_LOCALE). Used for number formatting and sort collation. */
  locale?: string;
  /** Partial override of the default messages (DEFAULT_MESSAGES). */
  messages?: Partial<RendererMessages>;
  /** Only events declared in the Spec's events are delivered (state.set is not delivered). */
  onEvent?: (event: SurfaceEvent) => void;
  /** Notification of exceptions thrown during node rendering (invoked by the per-node try/catch when it catches). */
  onNodeError?: (args: { componentId: string; componentType: string; error: unknown }) => void;
  /** Completion notification for writes (action.invoke). */
  onActionResult?: (args: {
    componentId: string;
    action: string;
    phase: "succeeded" | "failed";
    result?: unknown;
    message?: string;
  }) => void;
  /** Bridge required to run L2 (sandbox.html) parts. If unset, L2 becomes an injection-request placeholder. */
  sandbox?: { bridge: SandboxBridge; policy?: SandboxPolicy };
}

/**
 * Execution context scoped to a single Spec render. <kohaku-surface> rebuilds it on every Spec swap.
 * The store is retained by intent.hash, and the bus stays the same for the lifetime of the surface.
 */
export interface RenderRuntime {
  spec: UISpec;
  byId: Map<string, ComponentNode>;
  store: SpecStateStore;
  bus: DataInvalidationBus;
  controller: BoundDataController;
  binding: BindingClient | undefined;
  theme: ThemeTokens;
  locale: string;
  messages: RendererMessages;
  onNodeError: SurfaceContext["onNodeError"];
  onActionResult: SurfaceContext["onActionResult"];
  sandbox: SurfaceContext["sandbox"];
  /** Table of type → part builder (createCoreRenderRegistry). */
  registry: Map<string, PartBuilder>;

  /** Flows a forward event upstream via CustomEvent + onEvent (regardless of whether a sink is present). */
  dispatchForward(event: SurfaceEvent): void;

  /** Builds node id directly under parent (encapsulates visibleWhen / row template / per-node try-catch). */
  mountNode(parent: ParentNode, id: string, row: JsonObject | null): Teardown;
  /** Builds a group of child ids in order directly under parent. */
  mountChildren(parent: ParentNode, childIds: string[] | undefined, row: JsonObject | null): Teardown;
  /** Builds a sandbox.html node (the WC wrapper around mountSandbox). */
  mountSandbox(parent: ParentNode, node: ComponentNode): Teardown;

  /**
   * Applies event-emission governance (the glue for resolveEmit). state.set updates the store, forward calls
   * dispatchForward, and drop discards. row is the current row within a presentList template.
   */
  emit(node: ComponentNode, eventName: string, runtime: JsonObject, row: JsonObject | null): void;
  /**
   * Applies the write path (the glue for resolveInvokeTarget). For invoke, runs binding.invokeAction directly
   * and publishes invalidates to the bus; otherwise falls back to emit. Reports progress state via onPhase.
   */
  invoke(
    node: ComponentNode,
    eventName: string,
    runtime: JsonObject,
    row: JsonObject | null,
    onPhase: (phase: ActionPhase) => void,
  ): Promise<void>;
}

/**
 * A part's DOM builder. Appends its own element to parent and returns a teardown function.
 * (Making append the builder's responsibility lets a bound part safely perform an asynchronous
 * state-swapping replaceWith against an already-appended element.)
 */
export type PartBuilder = (
  rt: RenderRuntime,
  parent: ParentNode,
  node: ComponentNode,
  row: JsonObject | null,
) => Teardown;
