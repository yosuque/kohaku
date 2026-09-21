// parity harness: renders the same UI Spec + context in both React (renderer-react) and WC (renderer-wc)
// and returns the normalized DOM trees side by side. To guarantee mechanically that both renderers "consume the same input",
// binding / theme / locale / messages are distributed to both from a single description (toReactCtx / toWcCtx below).
//
// React renders the provider + SpecView with @testing-library/react and flushes the async bound-data resolution via act.
// WC renders <kohaku-surface> via property assignment and drains microtasks. We wait for both before comparing.

import type { BindingClient } from "@kohaku-ui/data-binding";
import {
  type RendererContextValue,
  RendererProvider,
  SpecView,
  type SurfaceEvent,
} from "@kohaku-ui/renderer-react";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import type { ComponentNode, ThemeTokens, UISpec } from "@kohaku-ui/spec-core";
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
}

function toReactCtx(ctx: ParityContext, onEvent?: (e: SurfaceEvent) => void): RendererContextValue {
  return {
    impls: createCoreRegistry(),
    theme: ctx.theme ?? {},
    ...(ctx.binding != null ? { binding: ctx.binding() } : {}),
    ...(ctx.locale != null ? { locale: ctx.locale } : {}),
    ...(ctx.messages != null ? { messages: ctx.messages } : {}),
    ...(onEvent != null ? { onEvent } : {}),
    ...(ctx.onActionResult != null ? { onActionResult: ctx.onActionResult } : {}),
    ...(ctx.renderSandbox != null ? { renderSandbox: ctx.renderSandbox } : {}),
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
        children: createElement(SpecView, { spec }),
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
  surface.context = toWcCtx(ctx, onEvent);
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
