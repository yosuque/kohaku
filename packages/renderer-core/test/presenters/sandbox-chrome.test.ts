import { describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGES,
  defaultDarkTheme,
  defaultLightTheme,
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
} from "../../src/index.js";

describe("sandbox-chrome presenter (shared by SandboxFrame and mountSandboxNode)", () => {
  it("badge / description read straight from RendererMessages", () => {
    expect(sandboxBadgeText(DEFAULT_MESSAGES)).toBe("L2 SANDBOXED");
    expect(sandboxBadgeDescriptionText(DEFAULT_MESSAGES)).toContain("isolated iframe");
  });

  it("loading notice text comes from messages.sandboxLoading", () => {
    expect(sandboxLoadingNoticeText(DEFAULT_MESSAGES)).toBe("Starting the sandbox…");
  });

  it("error notice prefers the guest-reported detail over the generic fallback", () => {
    expect(sandboxErrorNoticeText("boom", DEFAULT_MESSAGES)).toBe("boom");
    expect(sandboxErrorNoticeText(undefined, DEFAULT_MESSAGES)).toBe("An error occurred in the sandbox");
  });

  it("artifact-missing / bridge-missing notices are derived from messages", () => {
    expect(sandboxArtifactMissingText(DEFAULT_MESSAGES)).toBe(
      "No sandbox artifact (inline HTML is required)",
    );
    expect(sandboxBridgeMissingText("sandbox.html", DEFAULT_MESSAGES)).toBe(
      "Rendering the L2 component (sandbox.html) requires injecting the sandbox bridge",
    );
  });

  it("tone → style mapping resolves through the theme (info = surface/muted, error = negative surface/text)", () => {
    expect(sandboxNoticeToneStyle("info", {})).toEqual({
      background: defaultLightTheme["color.surface"],
      color: defaultLightTheme["color.muted"],
    });
    expect(sandboxNoticeToneStyle("error", {})).toEqual({
      background: defaultLightTheme["color.negative.surface"],
      color: defaultLightTheme["color.negative.text"],
    });
    expect(sandboxNoticeToneStyle("error", defaultDarkTheme).background).toBe(
      defaultDarkTheme["color.negative.surface"],
    );
  });

  it("badge chrome is built from warning-tone and sizing tokens (no hard-coded hex)", () => {
    expect(sandboxBadgeRowStyle({})).toMatchObject({
      color: defaultLightTheme["color.warning.text"],
      fontSize: "11px",
    });
    expect(sandboxBadgePillStyle({})).toMatchObject({
      background: defaultLightTheme["color.warning.surface"],
      borderRadius: "4px",
    });
    expect(sandboxBadgeDescriptionStyle({})).toEqual({ color: defaultLightTheme["color.muted"] });
    expect(sandboxNoticeBaseStyle({})).toMatchObject({ borderRadius: "8px", fontSize: "12.5px" });
  });

  // The assertions above pin only the default-light resolution, which a hard-coded literal would also
  // satisfy (defaultLightTheme's warning/muted values are the same strings the old hard-coded hex was).
  // Re-resolve against defaultDarkTheme (whose warning/muted values are genuinely different strings) so a
  // regression that hard-codes the light value back in would fail here even though the test above stays green.
  it("badge chrome re-resolves against a non-default theme (proves it isn't still hard-coded)", () => {
    expect(sandboxBadgeRowStyle(defaultDarkTheme).color).toBe(defaultDarkTheme["color.warning.text"]);
    expect(sandboxBadgePillStyle(defaultDarkTheme).background).toBe(
      defaultDarkTheme["color.warning.surface"],
    );
    expect(sandboxBadgeDescriptionStyle(defaultDarkTheme).color).toBe(defaultDarkTheme["color.muted"]);
  });

  it("messages are overridable like any other RendererMessages entry", () => {
    const overridden = { ...DEFAULT_MESSAGES, sandboxBadgeLabel: "L2 サンドボックス" };
    expect(sandboxBadgeText(overridden)).toBe("L2 サンドボックス");
  });
});
