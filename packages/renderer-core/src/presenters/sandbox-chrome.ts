// framework-free / DOM-free. The single source of truth for the wording, tone mapping, and inline
// styles of the L2 sandbox chrome (the "L2 SANDBOXED" badge + its status notice), shared by
// SandboxFrame (React, @kohaku-ui/sandbox/react) and mountSandboxNode (WC, renderer-wc's
// sandbox-mount.ts). Both wrap the same underlying mountSandbox iframe; before this module they
// duplicated the wording/colors verbatim, which let the two renderers drift silently. Strings are
// read from RendererMessages (overridable like any other UI string, i18n'd the same way); styles are
// resolved through resolveToken against the caller's theme so both renderers, given the same theme,
// resolve byte-identical values (the parity mechanism, see theme.ts's resolveToken docstring).

import type { ThemeTokens } from "@kohaku-ui/spec-core";
import type { RendererMessages } from "../messages.js";
import { resolveToken, type SizingTokens } from "../theme.js";

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
export function sandboxBadgeRowStyle(theme: ThemeTokens, sizing: SizingTokens): StyleRecord {
  return {
    display: "flex",
    alignItems: "center",
    gap: sizing.space2,
    fontSize: sizing.fontXs,
    color: resolveToken(theme, "color.warning.text"),
    marginBottom: sizing.space2,
  };
}

/** The "L2 SANDBOXED" pill itself. */
export function sandboxBadgePillStyle(theme: ThemeTokens, sizing: SizingTokens): StyleRecord {
  return {
    background: resolveToken(theme, "color.warning.surface"),
    borderRadius: sizing.radiusSm,
    padding: "1px 6px",
    fontWeight: 600,
  };
}

/** The muted explanatory text next to the pill. Colors-only, so it takes `theme` alone (no non-color token to read). */
export function sandboxBadgeDescriptionStyle(theme: ThemeTokens): StyleRecord {
  return { color: resolveToken(theme, "color.muted") };
}

/**
 * tone → {background, color} for the status notice box (info = neutral surface, error = negative).
 * Colors-only, so it takes `theme` alone (no non-color token to read).
 */
export function sandboxNoticeToneStyle(
  tone: SandboxNoticeTone,
  theme: ThemeTokens,
): { background: string; color: string } {
  return tone === "error"
    ? {
        background: String(resolveToken(theme, "color.negative.surface")),
        color: String(resolveToken(theme, "color.negative.text")),
      }
    : {
        background: String(resolveToken(theme, "color.surface")),
        color: String(resolveToken(theme, "color.muted")),
      };
}

/**
 * The notice box's tone-independent layout style (spread together with sandboxNoticeToneStyle).
 * Non-color-only, so it takes `sizing` alone (no color token to read — colors come from
 * sandboxNoticeToneStyle above).
 */
export function sandboxNoticeBaseStyle(sizing: SizingTokens): StyleRecord {
  return {
    borderRadius: sizing.radiusMd,
    padding: `${sizing.space2} ${sizing.space3}`,
    fontSize: sizing.fontSm,
  };
}
