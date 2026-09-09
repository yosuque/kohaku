import { describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGES,
  sandboxArtifactMissingText,
  sandboxBadgeDescriptionText,
  sandboxBadgeText,
  sandboxBridgeMissingText,
  sandboxErrorNoticeText,
  sandboxLoadingNoticeText,
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

  it("tone → style mapping is distinct for info vs error (unknown tones are not accepted by the type)", () => {
    expect(sandboxNoticeToneStyle("info")).toEqual({ background: "#f4f4f7", color: "#6b7280" });
    expect(sandboxNoticeToneStyle("error")).toEqual({ background: "#fee2e2", color: "#991b1b" });
  });

  it("messages are overridable like any other RendererMessages entry", () => {
    const overridden = { ...DEFAULT_MESSAGES, sandboxBadgeLabel: "L2 サンドボックス" };
    expect(sandboxBadgeText(overridden)).toBe("L2 サンドボックス");
  });
});
