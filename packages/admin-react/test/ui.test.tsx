import { KohakuHostError } from "@kohaku-ui/client";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adminThemeStyle, defaultAdminMessages } from "../src/index.js";
import { deniedMessage, ErrorBanner, StatusBadge } from "../src/ui.js";

describe("ui primitives", () => {
  it("ErrorBanner renders an alert role when asked", () => {
    render(<ErrorBanner text="boom" role="alert" />);
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("StatusBadge prints the raw status identifier", () => {
    render(<StatusBadge status="changes_requested" />);
    expect(screen.getByText("changes_requested")).toBeTruthy();
  });

  it("deniedMessage explains CAPABILITY_DENIED and returns null otherwise", () => {
    // KohakuHostError's constructor is (code, message, status, requestId?, promotionStatus?) — see
    // packages/client/src/errors.ts (the brief's assumed (status, code, message) order does not match).
    const denied = new KohakuHostError("CAPABILITY_DENIED", "nope", 403);
    expect(deniedMessage(denied, "approving a promotion", defaultAdminMessages)).toBe(
      defaultAdminMessages.deniedMessage("CAPABILITY_DENIED", "approving a promotion"),
    );
    const other = new KohakuHostError("PROMOTION_INVALID", "nope", 422);
    expect(deniedMessage(other, "approving a promotion", defaultAdminMessages)).toBeNull();
  });

  it("adminThemeStyle expands tokens to --kohaku-* variables", () => {
    const style = adminThemeStyle({ "color.primary": "#123456" });
    expect(style["--kohaku-color-primary" as keyof typeof style]).toBe("#123456");
    expect(adminThemeStyle(undefined)).toEqual({});
  });
});
