import { describe, expect, it } from "vitest";
import { computeDelta, formatNumber, formatValue } from "../../src/index.js";

describe("formatValue", () => {
  it("number is thousands-separated; unit is appended if present", () => {
    expect(formatValue(1234, "number", "JPY", undefined, "en-US")).toBe("1,234");
    expect(formatValue(1234, "number", "JPY", "pt", "en-US")).toBe("1,234pt");
  });

  it("null is em-dash; non-numeric strings pass through", () => {
    expect(formatValue(null, "number", "JPY", undefined, "en-US")).toBe("—");
    expect(formatValue("N/A", "number", "JPY", undefined, "en-US")).toBe("N/A");
  });

  it("percent appends % at the end", () => {
    expect(formatValue(50, "percent", "JPY", undefined, "en-US")).toBe("50%");
  });

  it("currency uses Intl currency formatting (ICU-independent expectation)", () => {
    const expected = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(120000000);
    expect(formatValue(120000000, "currency", "JPY", undefined, "ja-JP")).toBe(expected);
  });
});

describe("formatNumber", () => {
  it("invalid currency code falls back to thousands separation", () => {
    expect(formatNumber(100, "currency", "NOT_A_CODE", "en-US")).toBe((100).toLocaleString("en-US"));
  });
});

describe("computeDelta", () => {
  it("positive is up/▲/signed, negative is down/▼ (sign comes from formatting)", () => {
    expect(computeDelta(3, "number", "JPY", undefined, "en-US")).toEqual({
      direction: "up",
      arrow: "▲",
      signed: "+3",
    });
    expect(computeDelta(-1234, "number", "JPY", undefined, "en-US")).toEqual({
      direction: "down",
      arrow: "▼",
      signed: "-1,234",
    });
  });

  it("0 is flat; non-numeric is null", () => {
    expect(computeDelta(0, "number", "JPY", undefined, "en-US")).toEqual({
      direction: "flat",
      arrow: "—",
      signed: "0",
    });
    expect(computeDelta("x", "number", "JPY", undefined, "en-US")).toBeNull();
  });

  it("unit is appended to signed values too", () => {
    expect(computeDelta(5, "number", "JPY", "%", "en-US")).toMatchObject({ signed: "+5%" });
  });
});
