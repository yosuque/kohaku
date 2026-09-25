import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adminThemeStyle } from "../src/index.js";
import { ErrorBanner, StatusBadge } from "../src/ui.js";

describe("ui primitives", () => {
  it("ErrorBanner renders an alert role when asked", () => {
    render(<ErrorBanner text="boom" role="alert" />);
    expect(screen.getByRole("alert").textContent).toBe("boom");
  });

  it("StatusBadge prints the raw status identifier", () => {
    render(<StatusBadge status="changes_requested" />);
    expect(screen.getByText("changes_requested")).toBeTruthy();
  });

  it("adminThemeStyle expands tokens to --kohaku-* variables", () => {
    const style = adminThemeStyle({ "color.primary": "#123456" });
    expect(style["--kohaku-color-primary" as keyof typeof style]).toBe("#123456");
    expect(adminThemeStyle(undefined)).toEqual({});
  });
});
