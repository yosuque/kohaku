import {
  type RendererMessages,
  type SandboxNoticeTone,
  sandboxArtifactMissingText,
  sandboxBadgeDescriptionStyle,
  sandboxBadgeDescriptionText,
  sandboxBadgePillStyle,
  sandboxBadgeRowStyle,
  sandboxBadgeText,
  sandboxBridgeMissingText,
  sandboxErrorNoticeText,
  sandboxLoadingNoticeText,
  sandboxNoticeBaseStyle,
  sandboxNoticeToneStyle,
} from "@kohaku-ui/renderer-core";
import { mountSandbox, type SandboxState } from "@kohaku-ui/sandbox";
import type { ComponentNode } from "@kohaku-ui/spec-core";
import { el, noop, text } from "./dom.js";
import type { RenderRuntime, Teardown } from "./types.js";

/**
 * WC wrapper for the sandbox.html node (equivalent to renderer-react's SandboxFrame; a ~30-line bridge).
 * mountSandbox is already raw-DOM and framework-free, so it is called directly against the container inside the shadow root.
 * The capability token stays with the parent of ctx.sandbox.bridge and never enters the iframe (reusing the sandbox design unmodified).
 * Bridges the invalidation-bus subscription to SandboxHandle.invalidate, conveying the write loop's data invalidation to the guest.
 */
export function mountSandboxNode(rt: RenderRuntime, parent: ParentNode, node: ComponentNode): Teardown {
  const wrapper = el("div", { "data-kohaku": node.id }, { width: "100%" });
  parent.appendChild(wrapper);

  const messages: RendererMessages = rt.messages;

  const artifact = node.artifact;
  if (artifact?.inline == null) {
    wrapper.appendChild(notice("error", sandboxArtifactMissingText(messages)));
    return noop;
  }
  if (rt.sandbox == null) {
    wrapper.appendChild(notice("error", sandboxBridgeMissingText(node.type, messages)));
    return noop;
  }

  // L2 badge (makes it explicit that isolated execution is in progress). Same wording as renderer-react
  // (both consume renderer-core's sandbox-chrome presenter, the single source of truth).
  const badgeRow = el("div", {}, sandboxBadgeRowStyle);
  const badge = el("span", {}, sandboxBadgePillStyle);
  badge.appendChild(text(sandboxBadgeText(messages)));
  const badgeNote = el("span", {}, sandboxBadgeDescriptionStyle);
  badgeNote.appendChild(text(sandboxBadgeDescriptionText(messages)));
  badgeRow.append(badge, badgeNote);

  const statusHolder = el("div", {}, { width: "100%" });
  const container = el("div", {}, { width: "100%" });
  wrapper.append(badgeRow, statusHolder, container);

  const allowedEvents = rt.spec.events
    .filter((e) => e.on.startsWith(`${node.id}.`))
    .map((e) => e.on.slice(node.id.length + 1));

  const handle = mountSandbox({
    container,
    componentId: node.id,
    artifact: { inline: artifact.inline, sha256: artifact.sha256 },
    ...(node.data?.$ref != null ? { allowedRef: node.data.$ref } : {}),
    allowedEvents,
    initialProps: node.props,
    bridge: rt.sandbox.bridge,
    ...(rt.sandbox.policy != null ? { policy: rt.sandbox.policy } : {}),
    // Inject theme tokens into the srcdoc (the same handoff as SandboxFrame). A theme change rides on the surface's
    // full re-render (rt rebuild → teardown / mount), so no subscription is needed here.
    theme: rt.theme,
  });

  // Keep the loading / error display in sync with state transitions (cleared on ready).
  const renderStatus = (state: SandboxState, detail?: string): void => {
    statusHolder.replaceChildren();
    if (state === "loading") statusHolder.appendChild(notice("info", sandboxLoadingNoticeText(messages)));
    else if (state === "error") {
      statusHolder.appendChild(notice("error", sandboxErrorNoticeText(detail, messages)));
    }
  };
  handle.onStateChange(renderStatus);

  // Bridge the write loop's data invalidation to the guest's in-place refetch (the capability stays with the parent).
  const ref = node.data?.$ref;
  const unsub = ref != null ? rt.bus.subscribe(ref, () => handle.invalidate(ref)) : noop;

  return () => {
    unsub();
    handle.destroy();
  };
}

function notice(tone: SandboxNoticeTone, message: string): HTMLElement {
  const node = el("div", {}, { ...sandboxNoticeBaseStyle, ...sandboxNoticeToneStyle(tone) });
  node.appendChild(text(message));
  return node;
}
