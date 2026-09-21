import { describe, expect, it } from "vitest";
import { extractPastedRef } from "../src/pages/admin/gallery-ref.js";

const FALLBACK = "query://gallery/canned";

describe("extractPastedRef", () => {
  it("extracts the ref from a double-quoted window.kohaku.fetchData call", () => {
    const html = '<script>window.kohaku.fetchData("query://sales/summary?fy=2026").then(() => {});</script>';
    expect(extractPastedRef(html, FALLBACK)).toBe("query://sales/summary?fy=2026");
  });

  it("extracts the ref from a single-quoted, unprefixed kohaku.fetchData call", () => {
    const html = "<script>kohaku.fetchData('query://sales/trend').then(() => {});</script>";
    expect(extractPastedRef(html, FALLBACK)).toBe("query://sales/trend");
  });

  it("extracts the ref from a backtick-quoted fetchData call", () => {
    const html = "<script>window.kohaku.fetchData(`query://sales/top`).then(() => {});</script>";
    expect(extractPastedRef(html, FALLBACK)).toBe("query://sales/top");
  });

  it("falls back when no fetchData call is present", () => {
    const html = "<script>window.kohaku.ready();</script>";
    expect(extractPastedRef(html, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back on empty input", () => {
    expect(extractPastedRef("", FALLBACK)).toBe(FALLBACK);
  });
});
