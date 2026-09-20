import {
  type BoundData,
  dataStateNoticeStyle,
  resolveDataStateView,
  resolveToken,
} from "@kohaku-ui/renderer-core";
import type { ComponentNode, KnownThemeTokens } from "@kohaku-ui/spec-core";
import { el, noop, text } from "../dom.js";
import type { RenderRuntime, Teardown } from "../types.js";

/**
 * Resolves a theme token as a string (equivalent to React's String(useToken(...))). Same shape as resolveToken:
 * the 2-argument form takes a known token (`keyof KnownThemeTokens`; delegates to the default-theme set), and an
 * arbitrary string token is only allowed via the 3-argument form, which requires a fallback.
 */
export function tokenStr(rt: RenderRuntime, name: keyof KnownThemeTokens): string;
export function tokenStr(rt: RenderRuntime, name: string, fallback: string): string;
export function tokenStr(rt: RenderRuntime, name: string, fallback?: string): string {
  return String(
    fallback === undefined
      ? resolveToken(rt.theme, name as keyof KnownThemeTokens)
      : resolveToken(rt.theme, name, fallback),
  );
}

/**
 * Common display for loading / stale / error (same markup as renderer-react's DataStateNotice).
 * Returns null for ready / idle since there is no display element.
 */
export function dataStateNotice(rt: RenderRuntime, state: BoundData): HTMLElement | null {
  const view = resolveDataStateView(state, rt.theme, rt.messages);
  if (view == null) return null;
  const node = el("div", { role: view.role }, dataStateNoticeStyle({ bg: view.bg, fg: view.fg }, rt.sizing));
  node.appendChild(text(view.text));
  return node;
}

/**
 * Common wiring for parts that carry reference-passed data. Places a swap anchor in parent, attaches a BoundDataController,
 * and on every onChange swaps in the result of render(state) (last-write-wins, invalidation, and freshness matching are guaranteed by the controller).
 * render conventionally returns dataStateNotice for non-ready states. childTeardown can return child cleanup for row templates, etc.
 */
export function mountBoundPart(
  rt: RenderRuntime,
  parent: ParentNode,
  node: ComponentNode,
  render: (state: BoundData) => { el: Node; teardown?: Teardown },
): Teardown {
  let current: ChildNode = document.createComment(`kohaku:bound:${node.id}`);
  parent.appendChild(current);
  let childTeardown: Teardown = noop;
  const detach = rt.controller.attach(node, rt.spec, (state) => {
    childTeardown();
    const next = render(state);
    childTeardown = next.teardown ?? noop;
    current.replaceWith(next.el);
    current = next.el as ChildNode;
  });
  return () => {
    detach();
    childTeardown();
  };
}
