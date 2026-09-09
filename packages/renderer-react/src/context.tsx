import type { BindingClient } from "@kohaku-ui/data-binding";
import {
  DEFAULT_LOCALE,
  resolveEmit,
  resolvePayloadTemplate,
  resolveRowProps,
  resolveToken,
  type SurfaceEvent,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject, KnownThemeTokens, ThemeTokens, UISpec } from "@kohaku-ui/spec-core";
import { type ComponentType, createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import {
  createDataInvalidationBus,
  type DataInvalidationBus,
  DataInvalidationContext,
} from "./data-invalidation.js";
import { DEFAULT_MESSAGES, type RendererMessages } from "./messages.js";
import { useRowContext, useSpecStateActions } from "./spec-state.js";

export type { SurfaceEvent };
// Payload template resolution / row template injection / event governance use the framework-free
// "source of truth" = renderer-core as the single source of truth. The public API
// (resolvePayloadTemplate / resolveRowProps / SurfaceEvent in index.ts) is kept unchanged via this re-export.
export { resolvePayloadTemplate, resolveRowProps };

/** Props received by a component implementation. Data is resolved by reference-passing via the useBoundData hook. */
export interface ImplProps {
  node: ComponentNode;
  /** Rendering result of child nodes referenced as children */
  children?: ReactNode;
}

export type ComponentImpl = ComponentType<ImplProps>;

/** Registry of type → React implementation (the range the surface has implemented = the source of SurfaceCapabilities) */
export class ImplRegistry {
  private readonly impls = new Map<string, { version: string; component: ComponentImpl }>();

  register(type: string, version: string, component: ComponentImpl): this {
    this.impls.set(type, { version, component });
    return this;
  }

  get(type: string): ComponentImpl | undefined {
    return this.impls.get(type)?.component;
  }

  /** supports table passed to registry.negotiate */
  supports(): Record<string, string> {
    return Object.fromEntries([...this.impls.entries()].map(([t, v]) => [t, `^${v.version}`]));
  }
}

export interface RendererContextValue {
  impls: ImplRegistry;
  binding?: BindingClient;
  theme: ThemeTokens;
  /** Only events declared in the Spec's events reach here */
  onEvent?: (event: SurfaceEvent) => void;
  /** Delegates rendering of sandbox.html nodes (injects SandboxFrame from @kohaku-ui/sandbox) */
  renderSandbox?: (node: ComponentNode, spec: UISpec) => ReactNode;
  /** Display language tag. Used for number/date formatting and sort collation (default "en-US", see DEFAULT_LOCALE). */
  locale?: string;
  /** Partial override of the default messages (DEFAULT_MESSAGES). If unspecified, output is identical to before. */
  messages?: Partial<RendererMessages>;
  /**
   * Notification of exceptions thrown during node rendering (called by the per-node error boundary when it catches one).
   * Exceptions inside event handlers or async paths do not reach here, per React's design.
   */
  onNodeError?: (args: { componentId: string; componentType: string; error: unknown }) => void;
  /**
   * Completion notification for a write (action.invoke). Because emit==="action.invoke" is executed directly by the renderer,
   * it no longer reaches onEvent — this is the alternate path that informs the page of its completion (success/failure).
   */
  onActionResult?: (args: {
    componentId: string;
    action: string;
    phase: "succeeded" | "failed";
    result?: unknown;
    message?: string;
  }) => void;
}

const RendererContext = createContext<RendererContextValue | null>(null);
const SpecContext = createContext<UISpec | null>(null);

export function RendererProvider(props: { value: RendererContextValue; children: ReactNode }): ReactNode {
  // The data invalidation bus is generated internally by the Provider (avoids adding the burden of passing it via value on the caller).
  // Created once with useRef so it stays stable across mounts.
  const busRef = useRef<DataInvalidationBus | null>(null);
  busRef.current ??= createDataInvalidationBus();
  return (
    <RendererContext.Provider value={props.value}>
      <DataInvalidationContext.Provider value={busRef.current}>
        {props.children}
      </DataInvalidationContext.Provider>
    </RendererContext.Provider>
  );
}

export function SpecProvider(props: { spec: UISpec; children: ReactNode }): ReactNode {
  return <SpecContext.Provider value={props.spec}>{props.children}</SpecContext.Provider>;
}

export function useRenderer(): RendererContextValue {
  const ctx = useContext(RendererContext);
  if (ctx == null) throw new Error("useRenderer must be used inside <RendererProvider>");
  return ctx;
}

export function useSpec(): UISpec {
  const spec = useContext(SpecContext);
  if (spec == null) throw new Error("useSpec must be used inside <SpecView>");
  return spec;
}

/**
 * Theme token lookup (the Spec is theme-independent — theming is resolved by the renderer, not encoded in the Spec). Same shape as resolveToken:
 * the 2-argument version takes a known token (`keyof KnownThemeTokens`; the default theme set = defaultLightTheme is the final fallback),
 * an arbitrary string token is only allowed via the 3-argument version that requires a fallback (kept for backward compatibility).
 */
export function useToken(name: keyof KnownThemeTokens): string | number;
export function useToken(name: string, fallback: string | number): string | number;
export function useToken(name: string, fallback?: string | number): string | number {
  const { theme } = useRenderer();
  return fallback === undefined
    ? resolveToken(theme, name as keyof KnownThemeTokens)
    : resolveToken(theme, name, fallback);
}

/** Display language tag (default "en-US", see DEFAULT_LOCALE). Used as the collation locale for number/date formatting and sort collation. */
export function useLocale(): string {
  return useRenderer().locale ?? DEFAULT_LOCALE;
}

/** Message catalog merging the default messages (DEFAULT_MESSAGES) with the context's partial overrides. */
export function useMessages(): RendererMessages {
  const { messages } = useRenderer();
  // The merge result is unchanged as long as messages is unchanged. Avoid regenerating on every render to keep the reference stable.
  return useMemo(
    () => (messages == null ? DEFAULT_MESSAGES : { ...DEFAULT_MESSAGES, ...messages }),
    [messages],
  );
}

/**
 * Fires an event from a component. Only on's already declared in the Spec's events are forwarded upstream,
 * with the payload template ($row.x / $value) resolved.
 *
 * Reads $state only through useSpecStateActions (setter-only, stable reference) rather than
 * useSpecState() — this hook never reads `values`, so subscribing to the full SpecStateApi would
 * re-render every component holding an onClick/onChange handler on every unrelated $state.set.
 */
export function useEmitEvent(node: ComponentNode): (eventName: string, runtime: JsonObject) => void {
  const { onEvent } = useRenderer();
  const spec = useSpec();
  const actions = useSpecStateActions();
  const row = useRowContext();
  return (eventName, runtime) => {
    // The governance decision (undeclared discard / state.set / forward) has renderer-core's resolveEmit
    // as the single source of truth (SPEC-EVT-002); this is only the glue that applies the decision.
    const res = resolveEmit(spec, node, eventName, runtime, row);
    if (res.kind === "state.set") {
      actions.set(res.key, res.value);
    } else if (res.kind === "forward") {
      onEvent?.(res.event);
    }
    // drop: undeclared events are discarded (governance).
  };
}
