import { createBindingClient } from "@kohaku-ui/data-binding";
import {
  type ImplRegistry,
  type RendererContextValue,
  RendererProvider,
  SpecView,
  type SurfaceEvent,
  useDataInvalidation,
} from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import { SandboxFrame } from "@kohaku-ui/sandbox/react";
import type { ComponentNode, JsonValue, ThemeTokens, UISpec } from "@kohaku-ui/spec-core";
import { type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { LOCALE_TAGS, useLang } from "../i18n/lang.js";
import { JA_MESSAGES } from "../i18n/messages.ja.js";
import { registerSalesImpls } from "../renderer-impls/index.js";
import { useThemeMode } from "../theme/mode.js";
import { buildTheme } from "../theme/tokens.js";
import { tenantHeader } from "./tenant.js";

/**
 * The integration point common to all pages: renderer-react + data-binding (Bearer capability) +
 * upstream forwarding of Spec-declared events + injection of sandbox rendering.
 * Both the GUI and chat surfaces render with the same SpecSurface = pixel parity (strategy A).
 */
export function SpecSurface(props: {
  spec: UISpec;
  capability: string;
  onEvent?: (event: SurfaceEvent) => void;
  /** Write (action.invoke) completion notification. Since emit no longer reaches onEvent, it is received here as an alternative path. */
  onActionResult?: RendererContextValue["onActionResult"];
  renderSandbox?: (node: ComponentNode, spec: UISpec) => ReactNode;
  /** Demo pass-through for SpecView's opt-in enableViewTransitions prop. Default off (see SpecView.tsx). */
  enableViewTransitions?: boolean;
}): ReactNode {
  // Compose the default theme + brand diff according to the theme mode (light/dark) and inject it into the Renderer.
  // Both the Web and chat surfaces pull the same theme, so the display matches regardless of mode.
  const { mode } = useThemeMode();
  const theme = useMemo(() => buildTheme(mode), [mode]);
  // App UI language: "ja" injects JA_MESSAGES (RendererMessages i18n override); "en" leaves messages
  // unset so the library default (English) applies. The renderer locale (number/date formatting,
  // collation) is set explicitly per language rather than relying on the library default.
  const { lang } = useLang();

  // Layer on the sales-domain part implementations (sales.kpiCard / sales.calendarHeatmap). The registration mapping
  // is single-sourced by renderer-impls' registerSalesImpls, and the MCP shared renderer uses the same function (strategy A).
  const impls = useMemo((): ImplRegistry => registerSalesImpls(createCoreRegistry()), []);

  const binding = useMemo(
    () =>
      createBindingClient({
        baseUrl: "/api/kohaku",
        capability: props.capability,
        // Carry the selected tenant on resolve / action (the write loop) too. Being a function, a switch takes effect from the next request.
        headers: tenantHeader,
      }),
    [props.capability],
  );

  // Delegation of L2 (sandbox.html) rendering. The capability stays in this bridge (the parent side) and
  // never enters the iframe — the parent proxies data resolution. It subscribes to the data invalidation bus and
  // bridges the write loop's in-place re-fetch to sandbox's invalidate (SandboxWithInvalidation).
  // useCallback keeps this stable across renders where theme/binding/onEvent are unchanged, so it does
  // not by itself force the RendererProvider value below to change identity.
  const renderSandbox = useCallback(
    (node: ComponentNode, spec: UISpec): ReactNode => (
      <SandboxWithInvalidation
        node={node}
        spec={spec}
        theme={theme}
        onEvent={props.onEvent}
        resolveBinding={async (ref) =>
          // If refVersions exist, match against the per-reference version (same logic as use-bound-data)
          (await binding.resolve(ref, {
            expectedDataVersion: spec.refVersions?.[ref] ?? spec.dataVersion,
          })) as unknown as JsonValue
        }
      />
    ),
    [theme, binding, props.onEvent],
  );

  // Memoized so every useRenderer() consumer across the whole Spec tree doesn't re-render whenever
  // SpecSurface itself re-renders for an unrelated reason (e.g. a parent state update) — only an actual
  // change to one of the dependencies below should change what the Renderer sees.
  const rendererValue = useMemo(
    (): RendererContextValue => ({
      impls,
      binding,
      theme,
      // Formatting locale follows the toggle (en-US / ja-JP); "ja" additionally injects the JA
      // message dictionary via the i18n override mechanism (RendererProvider.messages).
      locale: LOCALE_TAGS[lang],
      ...(lang === "ja" ? { messages: JA_MESSAGES } : {}),
      ...(props.onEvent != null ? { onEvent: props.onEvent } : {}),
      ...(props.onActionResult != null ? { onActionResult: props.onActionResult } : {}),
      renderSandbox: props.renderSandbox ?? renderSandbox,
    }),
    [impls, binding, theme, lang, props.onEvent, props.onActionResult, props.renderSandbox, renderSandbox],
  );

  return (
    <RendererProvider value={rendererValue}>
      <SpecView spec={props.spec} enableViewTransitions={props.enableViewTransitions} />
    </RendererProvider>
  );
}

/**
 * Wraps the L2 sandbox and subscribes to data invalidation of its own node's $ref, bridging it to the sandbox handle's invalidate.
 * Because it renders inside RendererProvider (via NodeView), useDataInvalidation is connected to the real bus.
 */
function SandboxWithInvalidation(props: {
  node: ComponentNode;
  spec: UISpec;
  /** Design tokens (injected into the sandbox iframe as CSS variables. Resolves the var(--kohaku-*) of L2 artifacts) */
  theme: ThemeTokens;
  onEvent?: (event: SurfaceEvent) => void;
  resolveBinding: (ref: string) => Promise<JsonValue>;
}): ReactNode {
  const invalidation = useDataInvalidation();
  const invalidateRef = useRef<((ref: string) => void) | null>(null);
  const ref = props.node.data?.$ref;
  const spec = props.spec;
  const onEvent = props.onEvent;

  useEffect(() => {
    if (ref == null) return;
    return invalidation.subscribe(ref, () => invalidateRef.current?.(ref));
  }, [ref, invalidation]);

  return (
    <SandboxFrame
      node={props.node}
      spec={spec}
      theme={props.theme}
      onHandle={(h) => {
        invalidateRef.current = h?.invalidate ?? null;
      }}
      bridge={{
        resolveBinding: props.resolveBinding,
        onEvent: (event) => {
          const on = `${event.componentId}.${event.on}`;
          const declared = spec.events.find((e) => e.on === on);
          if (declared != null) {
            onEvent?.({
              componentId: event.componentId,
              on,
              emit: declared.emit,
              payload: event.payload,
            });
          }
        },
        onTelemetry: (event) => {
          // The usage count (component.used) is recorded server-side by viewComposed at compose time.
          // Sending componentUsed from here on ready/error too would double-count and
          // let the promotion minUses threshold be satisfied by a single display, so we do not send it.
          if (event.kind === "error") {
            console.warn("[kohaku] sandbox render error", props.node.id, event);
          }
        },
      }}
    />
  );
}
