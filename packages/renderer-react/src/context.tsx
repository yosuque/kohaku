import type { BindingClient } from "@kohaku-ui/data-binding";
import type { ComponentDefinition } from "@kohaku-ui/registry";
import {
  type ActionManifest,
  DEFAULT_LOCALE,
  isDevEnvironment,
  PARTS_STATE_CSS,
  resolveEmit,
  resolvePayloadTemplate,
  resolveRowProps,
  resolveSizing,
  resolveToken,
  type SizingTokens,
  type SurfaceEvent,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode, JsonObject, KnownThemeTokens, ThemeTokens, UISpec } from "@kohaku-ui/spec-core";
import { type ComponentType, createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import type { z } from "zod";
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

/**
 * Props received by a typed component implementation built via `implement` (design.md #68): `props` is the
 * node's `props` parsed against the definition's `propsSchema` (no `node.props["x"] as T` cast at the call
 * site), while `node` stays available for anything the schema doesn't cover (id, data ref, etc.).
 */
export interface TypedImplProps<P> {
  node: ComponentNode;
  props: P;
  children?: ReactNode;
}

export type TypedComponentImpl<P> = ComponentType<TypedImplProps<P>>;

/** Registration triple returned by `implement`, consumed by `ImplRegistry.use`. */
export interface ImplEntry {
  type: string;
  version: string;
  component: ComponentImpl;
}

/**
 * Wraps a typed component (`TypedComponentImpl`) into a plain `ComponentImpl` bound to `def`'s own type and
 * version, so a product-specific part's `{type, version, propsSchema}` lives in exactly one place (the
 * `ComponentDefinition`) instead of being re-typed as string literals at the registration call site
 * (design.md #68). Pass the result to `ImplRegistry.use`.
 *
 * `def.propsSchema.safeParse` always runs, in every environment — not just outside a `NODE_ENV=production`
 * build — because it is also what materializes a `.default()`-ed prop (or any other Zod transform) the Spec
 * omits; skipping it in production would silently make `Component` see `undefined` for a prop its type says
 * is always present. On success, `Component` receives `parsed.data`; on failure it receives the raw
 * (unvalidated) `node.props` instead, matching the renderer's general fail-open policy (a malformed prop
 * should degrade the part's own display, not take down the surface). Only the **diagnostic** — a
 * `console.warn` on a mismatch — is gated by environment: by default it fires outside a `NODE_ENV=production`
 * build (see `isDevEnvironment`); pass `{ validate }` to force it on or off regardless of environment.
 */
export function implement<P extends z.ZodObject>(
  def: ComponentDefinition<P>,
  Component: TypedComponentImpl<z.infer<P>>,
  options?: { validate?: boolean },
): ImplEntry {
  const shouldWarn = options?.validate ?? isDevEnvironment();
  const Wrapped: ComponentImpl = ({ node, children }: ImplProps) => {
    const parsed = def.propsSchema.safeParse(node.props);
    let props: z.infer<P>;
    if (parsed.success) {
      props = parsed.data as z.infer<P>;
    } else {
      props = node.props as z.infer<P>;
      if (shouldWarn) {
        console.warn(
          `[kohaku] component "${def.type}" (node ${node.id}) received props that don't match its schema: ${parsed.error.message}`,
        );
      }
    }
    return (
      <Component node={node} props={props}>
        {children}
      </Component>
    );
  };
  Wrapped.displayName = `Implement(${def.type})`;
  return { type: def.type, version: def.version, component: Wrapped };
}

/** Registry of type → React implementation (the range the surface has implemented = the source of SurfaceCapabilities) */
export class ImplRegistry {
  private readonly impls = new Map<string, { version: string; component: ComponentImpl }>();

  register(type: string, version: string, component: ComponentImpl): this {
    this.impls.set(type, { version, component });
    return this;
  }

  /** Sugar for `register(entry.type, entry.version, entry.component)` — registers the result of `implement`. */
  use(entry: ImplEntry): this {
    return this.register(entry.type, entry.version, entry.component);
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
  /**
   * Delegates rendering of sandbox.html nodes (injects SandboxFrame from @kohaku-ui/sandbox). SpecView
   * calls this with this provider's own `theme` as the 3rd argument, so a host wiring `SandboxFrame`
   * (or `<kohaku-surface>`'s equivalent on the WC side, which is already automatic — see sandbox-mount.ts)
   * does not need to separately thread `theme` through its own closure to keep it in sync.
   */
  renderSandbox?: (node: ComponentNode, spec: UISpec, theme: ThemeTokens) => ReactNode;
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
  /**
   * The compose-issued Action manifest (design.md #62/#64), threaded through to `useInvokeAction` /
   * `runInvokeTarget` for a client-side `preflightAction` check before the round trip. Typically taken
   * from the current `ComposeView.actions` (undefined when the Spec declares no write actions). Absent ->
   * no local check; the server remains authoritative.
   */
  actionManifest?: ActionManifest;
  /**
   * Confirmation hook for a "confirm"-tier action (design.md #62/#63). When unset, defaults to
   * `globalThis.confirm` (declining — i.e. returning `false` — when `confirm` is unavailable in this
   * environment, e.g. SSR). Pass your own to replace the native browser dialog with an in-app one.
   */
  confirm?: (args: { action: string; message?: string }) => boolean | Promise<boolean>;
  /**
   * Approval-token hook for an "approve"-tier action (design.md #63). No default is provided (an approval
   * token is obtained out of band — e.g. the host's `POST /approvals` or an approver-facing surface —
   * there is no generic browser-native equivalent of `globalThis.confirm` for it).
   */
  requestApproval?: (args: {
    action: string;
    payload: JsonObject;
  }) => string | undefined | Promise<string | undefined>;
  /**
   * `nonce` passed through to the `<style href="kohaku-parts-state">` RendererProvider injects (see
   * `PARTS_STATE_CSS`'s own doc comment). A host running a strict `style-src-elem` CSP with a per-request
   * nonce has no other way to authorize this element (React 19 hoists it into `<head>`, so it cannot be
   * wrapped or styled by the host's own CSP-exempt markup). Omitted by default — byte-identical to before
   * this field existed.
   */
  stateStylesNonce?: string;
  /**
   * Set to `false` to skip injecting the `<style href="kohaku-parts-state">` element entirely (opt-out).
   * Use this when the host cannot satisfy its CSP for the element even with a nonce, or already supplies
   * an equivalent stylesheet of its own — the state styles are theme-neutral and taken from
   * `PARTS_STATE_CSS`, which a host can inline itself. Default (omitted / any value other than `false`)
   * keeps today's behavior: the element is always injected.
   */
  stateStyles?: false;
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
        {/* Theme-neutral hover/active/focus-visible rules for the parts. React 19 hoists a <style> with href +
            precedence into <head> and de-duplicates it by href, so N providers yield one stylesheet.
            stateStyles: false skips this entirely (opt-out); stateStylesNonce passes a CSP nonce through
            (both RendererContextValue fields default to today's unconditional-injection behavior). */}
        {props.value.stateStyles !== false && (
          <style
            href="kohaku-parts-state"
            precedence="default"
            {...(props.value.stateStylesNonce != null ? { nonce: props.value.stateStylesNonce } : {})}
          >
            {PARTS_STATE_CSS}
          </style>
        )}
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

/** The non-color tokens of the current theme as a flat bag (memoized per theme object). */
export function useSizing(): SizingTokens {
  const { theme } = useRenderer();
  return useMemo(() => resolveSizing(theme), [theme]);
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
