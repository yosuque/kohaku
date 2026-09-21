import { describe, expect, it } from "vitest";
import { galleryBadge, galleryKitCss } from "../src/pages/admin/GalleryTab.js";

/**
 * Unit coverage for GalleryTab's two pure prop-mapping helpers. Mounting the real SandboxFrame (a real
 * iframe with a srcdoc'd guest document) is impractical in jsdom, so these are extracted as tiny exported
 * functions and tested directly instead — see their own doc comments in GalleryTab.tsx.
 */
describe("galleryKitCss", () => {
  it("checked (kit on) maps to undefined — SandboxFrame's default: inject the built-in kit", () => {
    expect(galleryKitCss(true)).toBeUndefined();
  });

  it("unchecked (kit off) maps to the empty string — inject nothing", () => {
    expect(galleryKitCss(false)).toBe("");
  });
});

describe("galleryBadge", () => {
  it("hides the badge on the showcase preview", () => {
    expect(galleryBadge("showcase")).toBe("hidden");
  });

  it("shows the badge on the pasted preview (the one on-screen sandboxing signal for arbitrary HTML)", () => {
    expect(galleryBadge("pasted")).toBe("visible");
  });
});
