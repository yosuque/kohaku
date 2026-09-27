// parity harness: renders the same UI Spec + context in both React (renderer-react) and WC (renderer-wc)
// and returns the normalized DOM trees side by side. To guarantee mechanically that both renderers "consume the same input",
// binding / theme / locale / messages are distributed to both from a single description (toReactCtx / toWcCtx below).
//
// React renders the provider + SpecView with @testing-library/react and flushes the async bound-data resolution via act.
// WC renders <kohaku-surface> via property assignment and drains microtasks. We wait for both before comparing.

import type { BindingClient } from "@kohaku-ui/data-binding";
import type { ActionManifest } from "@kohaku-ui/renderer-core";
import {
  type ImplRegistry,
  type RendererContextValue,
  RendererProvider,
  SpecView,
  type SurfaceEvent,
} from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import type { ComponentNode, JsonObject, ThemeTokens, UISpec } from "@kohaku-ui/spec-core";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  defineKohakuSurface,
  KOHAKU_EVENT,
  type KohakuSurface,
  type SurfaceContext,
} from "../../src/index.js";
import { normalize, normalizeChildren, type SemanticNode } from "./normalize.js";

defineKohakuSurface();

/** Common type for the action.invoke completion notification (identical in React / WC). */
export type ActionResultArg = {
  componentId: string;
  action: string;
  phase: "succeeded" | "failed";
  result?: unknown;
  message?: string;
};

/** Render context distributed to both renderers. binding is received as a factory so each renderer can hold a separate instance. */
export interface ParityContext {
  binding?: () => BindingClient;
  theme?: ThemeTokens;
  locale?: string;
  messages?: Partial<RendererContextValue["messages"]>;
  onEvent?: (event: SurfaceEvent) => void;
  onActionResult?: (arg: ActionResultArg) => void;
  /** L2 (sandbox.html) delegation, React side (RendererProvider.renderSandbox). */
  renderSandbox?: (node: ComponentNode, spec: UISpec, theme: ThemeTokens) => ReactNode;
  /** L2 (sandbox.html) delegation, WC side (context.sandbox: the bridge + optional policy). */
  sandbox?: SurfaceContext["sandbox"];
  /** AI-generation disclosure (design.md #66) -- React's SpecView prop / WC's <kohaku-surface> attribute.
   * Not part of RendererContextValue/SurfaceContext (it is orthogonal to the renderer context), so it is
   * applied directly rather than threaded through toReactCtx/toWcCtx. */
  disclosure?: "off" | "attributes" | "label";
  /**
   * Overrides the React impl registry (default: `createCoreRegistry()`). Used by custom-part parity tests
   * (design.md #68) that register a product-specific part via `implement`/`ImplRegistry.use` on top of the
   * core catalog, so both renderers are asked to draw a type neither one implements out of the box.
   */
  impls?: () => ImplRegistry;
  /**
   * Registers product-specific parts on the WC surface before its Spec is assigned, mirroring `impls` on
   * the React side (design.md #68's `<kohaku-surface>.registerPart` / `implementWc`).
   */
  registerParts?: (surface: KohakuSurface) => void;
  /** Governed actions (design.md #62/#63/#64) -- the compose-issued manifest + confirm/requestApproval hooks. */
  actionManifest?: ActionManifest;
  confirm?: (args: { action: string; message?: string }) => boolean | Promise<boolean>;
  requestApproval?: (args: {
    action: string;
    payload: JsonObject;
  }) => string | undefined | Promise<string | undefined>;
}

function toReactCtx(ctx: ParityContext, onEvent?: (e: SurfaceEvent) => void): RendererContextValue {
  return {
    impls: ctx.impls?.() ?? createCoreRegistry(),
    theme: ctx.theme ?? {},
    ...(ctx.binding != null ? { binding: ctx.binding() } : {}),
    ...(ctx.locale != null ? { locale: ctx.locale } : {}),
    ...(ctx.messages != null ? { messages: ctx.messages } : {}),
    ...(onEvent != null ? { onEvent } : {}),
    ...(ctx.onActionResult != null ? { onActionResult: ctx.onActionResult } : {}),
    ...(ctx.renderSandbox != null ? { renderSandbox: ctx.renderSandbox } : {}),
    ...(ctx.actionManifest != null ? { actionManifest: ctx.actionManifest } : {}),
    ...(ctx.confirm != null ? { confirm: ctx.confirm } : {}),
    ...(ctx.requestApproval != null ? { requestApproval: ctx.requestApproval } : {}),
  };
}

function toWcCtx(ctx: ParityContext, onEvent?: (e: SurfaceEvent) => void): SurfaceContext {
  return {
    theme: ctx.theme ?? {},
    ...(ctx.binding != null ? { binding: ctx.binding() } : {}),
    ...(ctx.locale != null ? { locale: ctx.locale } : {}),
    ...(ctx.messages != null ? { messages: ctx.messages } : {}),
    ...(onEvent != null ? { onEvent } : {}),
    ...(ctx.onActionResult != null ? { onActionResult: ctx.onActionResult } : {}),
    ...(ctx.sandbox != null ? { sandbox: ctx.sandbox } : {}),
    ...(ctx.actionManifest != null ? { actionManifest: ctx.actionManifest } : {}),
    ...(ctx.confirm != null ? { confirm: ctx.confirm } : {}),
    ...(ctx.requestApproval != null ? { requestApproval: ctx.requestApproval } : {}),
  };
}

/** Drains a few turns of microtasks (flushes WC's async data-resolution .then chains). */
export async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Flushes React's bound-data resolution (promise → setState) inside act. */
export async function flushReact(): Promise<void> {
  await act(async () => {
    await tick();
  });
}

/** Renders the React tree and returns the root component node (the topmost of SpecView's output). */
export async function renderReact(
  spec: UISpec,
  ctx: ParityContext = {},
  onEvent?: (e: SurfaceEvent) => void,
): Promise<{ container: HTMLElement; rootEl: Element }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    render(
      // RendererProvider declares `children: ReactNode` as a required named prop (not the implicit-children
      // pattern), so createElement's variadic-children overload does not typecheck here: the props object
      // itself must carry `children`. See the component's declaration in renderer-react/src/context.tsx.
      createElement(RendererProvider, {
        value: toReactCtx(ctx, onEvent),
        // biome-ignore lint/correctness/noChildrenProp: required by RendererProvider's named `children` prop type (see comment above).
        children: createElement(SpecView, {
          spec,
          ...(ctx.disclosure != null ? { disclosure: ctx.disclosure } : {}),
        }),
      }),
      { container },
    );
  });
  await flushReact();
  // Select the part carrying `data-kohaku` explicitly rather than assuming it is
  // `container.firstElementChild` — that assumption only held because React 19 hoists
  // RendererProvider's state `<style href="kohaku-parts-state" precedence>` (see
  // packages/renderer-react/src/context.tsx) into `<head>`, leaving the part as the sole child of
  // `container`. Querying by the attribute every part's root carries keeps this helper correct even if
  // that hoisting behavior ever changes (a different React version, or a host opting the stylesheet out).
  const rootEl = container.querySelector("[data-kohaku]") as Element;
  return { container, rootEl };
}

/** Renders the WC surface and returns the root component node (the topmost under .kohaku-root). */
export async function renderWc(
  spec: UISpec,
  ctx: ParityContext = {},
  onEvent?: (e: SurfaceEvent) => void,
): Promise<{ surface: KohakuSurface; rootEl: Element }> {
  const surface = document.createElement("kohaku-surface") as KohakuSurface;
  document.body.appendChild(surface);
  ctx.registerParts?.(surface);
  surface.context = toWcCtx(ctx, onEvent);
  if (ctx.disclosure != null) surface.disclosure = ctx.disclosure;
  surface.spec = spec;
  await tick();
  const shadowRoot = surface.shadowRoot!.querySelector(".kohaku-root") as HTMLElement;
  return { surface, rootEl: shadowRoot.firstElementChild as Element };
}

/** Normalizes both renderers' root component nodes and returns them side by side (the main check for structural parity). */
export async function renderPair(
  spec: UISpec,
  ctx: ParityContext = {},
): Promise<{ react: SemanticNode; wc: SemanticNode; surface: KohakuSurface; container: HTMLElement }> {
  const { container, rootEl: reactRoot } = await renderReact(spec, ctx);
  const { surface, rootEl: wcRoot } = await renderWc(spec, ctx);
  return { react: normalize(reactRoot), wc: normalize(wcRoot), surface, container };
}

/** Test cleanup (unmount of the React tree). Used together with setup.ts's body clearing. */
export function cleanupPair(): void {
  cleanup();
}

export type { SemanticNode, SurfaceEvent };
export { KOHAKU_EVENT, normalize, normalizeChildren };
