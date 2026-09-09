// framework-free / DOM-free. The single source of truth for the wording, tone mapping, and inline
// styles of the L2 sandbox chrome (the "L2 SANDBOXED" badge + its status notice), shared by
// SandboxFrame (React, @kohaku-ui/sandbox/react) and mountSandboxNode (WC, renderer-wc's
// sandbox-mount.ts). Both wrap the same underlying mountSandbox iframe; before this module they
// duplicated the wording/colors verbatim, which let the two renderers drift silently. Strings are
// read from RendererMessages (overridable like any other UI string, i18n'd the same way);
// the concrete hex colors are kept as plain descriptor values here (token mapping is out of scope).

import type { RendererMessages } from "../messages.js";

type StyleRecord = Record<string, string | number>;

/** Notice tone: "info" while starting up, "error" once the sandbox reports a failure. */
export type SandboxNoticeTone = "info" | "error";

/** The "L2 SANDBOXED" badge label. */
export function sandboxBadgeText(messages: Pick<RendererMessages, "sandboxBadgeLabel">): string {
  return messages.sandboxBadgeLabel;
}

/** The explanatory copy shown next to the badge. */
export function sandboxBadgeDescriptionText(
  messages: Pick<RendererMessages, "sandboxBadgeDescription">,
): string {
  return messages.sandboxBadgeDescription;
}

/** Notice text while the iframe is starting up (mountSandbox state "loading"). */
export function sandboxLoadingNoticeText(messages: Pick<RendererMessages, "sandboxLoading">): string {
  return messages.sandboxLoading;
}

/**
 * Notice text once the sandbox reports an error (mountSandbox state "error"). The guest-reported
 * detail, when present, takes precedence over the generic fallback.
 */
export function sandboxErrorNoticeText(
  detail: string | undefined,
  messages: Pick<RendererMessages, "sandboxErrorFallback">,
): string {
  return detail ?? messages.sandboxErrorFallback;
}

/** Notice text when the node carries no inline HTML to run (never reaches mountSandbox). */
export function sandboxArtifactMissingText(
  messages: Pick<RendererMessages, "sandboxArtifactMissing">,
): string {
  return messages.sandboxArtifactMissing;
}

/**
 * Notice text when the host did not inject the sandbox bridge (WC-only path: renderer-react always
 * has a renderSandbox callback by construction once SandboxFrame is wired). `type` is the
 * component's declared type (e.g. "sandbox.html").
 */
export function sandboxBridgeMissingText(
  type: string,
  messages: Pick<RendererMessages, "sandboxBridgeMissing">,
): string {
  return messages.sandboxBridgeMissing(type);
}

/** The badge row's layout style (flex row holding the pill + description). */
export const sandboxBadgeRowStyle: StyleRecord = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 11.5,
  color: "#c2410c",
  marginBottom: 6,
};

/** The "L2 SANDBOXED" pill itself. */
export const sandboxBadgePillStyle: StyleRecord = {
  background: "#ffedd5",
  borderRadius: 4,
  padding: "2px 8px",
  fontWeight: 700,
};

/** The muted explanatory text next to the pill. */
export const sandboxBadgeDescriptionStyle: StyleRecord = { color: "#9ca3af" };

/** tone → {background, color} for the status notice box (info = neutral gray, error = red). */
export function sandboxNoticeToneStyle(tone: SandboxNoticeTone): { background: string; color: string } {
  return tone === "error"
    ? { background: "#fee2e2", color: "#991b1b" }
    : { background: "#f4f4f7", color: "#6b7280" };
}

/** The notice box's tone-independent layout style (spread together with sandboxNoticeToneStyle). */
export const sandboxNoticeBaseStyle: StyleRecord = {
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 12.5,
};
