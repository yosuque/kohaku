import { describe, expect, it } from "vitest";
import {
  actionButtonStyle,
  chartCaptionStyle,
  controlSelectStyle,
  dataStateNoticeStyle,
  defaultLightTheme,
  dialogBoxStyle,
  fieldRowStyle,
  formControlBaseStyle,
  formRootStyle,
  formSubmitButtonStyle,
  gapFor,
  listEmptyStyle,
  loadingStyle,
  metricCardStyle,
  metricDeltaStyle,
  metricLabelStyle,
  metricValueStyle,
  resolveSizing,
  spreadsheetPagerButtonStyle,
  spreadsheetTdStyle,
  spreadsheetThStyle,
  tabButtonStyle,
  textBodyStyle,
  textCodeStyle,
  textPreStyle,
  toastStyle,
} from "../../src/index.js";

const sizing = resolveSizing({
  "radius.md": "3px",
  "space.2": "9px",
  "font.size.md": "14px",
  "shadow.sm": "none",
});
const defaults = resolveSizing({});

describe("presenter sizing (non-color tokens flow into every inline style)", () => {
  it("gapFor maps the layout gap keywords onto the space scale", () => {
    expect(gapFor(defaults, "none")).toBe("0");
    expect(gapFor(defaults, "sm")).toBe("8px");
    expect(gapFor(defaults, "md")).toBe("16px");
    expect(gapFor(defaults, "lg")).toBe("24px");
    expect(gapFor(defaults, undefined)).toBe("16px");
    expect(gapFor(defaults, "bogus")).toBe("16px");
    expect(gapFor(sizing, "sm")).toBe("9px");
  });

  it("buttons / tabs / form controls read radius, padding and font size from the sizing bag", () => {
    const btn = actionButtonStyle(
      "primary",
      { primary: "#000", border: "#ccc", danger: "#f00", text: "#111", onPrimary: "#fff" },
      { disabled: false },
      sizing,
    );
    expect(btn.borderRadius).toBe("3px");
    expect(btn.padding).toBe("9px 16px");
    expect(btn.fontSize).toBe("14px");
    expect(btn.fontWeight).toBe(600);
    expect(tabButtonStyle({ accent: "#000", muted: "#888" }, { active: true }, sizing).fontSize).toBe("14px");
    expect(formControlBaseStyle("#ccc", sizing).borderRadius).toBe("3px");
    expect(formSubmitButtonStyle("#000", "#fff", { busy: false }, sizing).borderRadius).toBe("3px");
    expect(formRootStyle(sizing).gap).toBe("12px");
    expect(fieldRowStyle(sizing).fontSize).toBe("12.5px");
    expect(controlSelectStyle("#ccc", sizing).borderRadius).toBe("3px");
  });

  it("omitting sizing keeps the default-light values (backward compatible call sites)", () => {
    const btn = actionButtonStyle(
      "primary",
      { primary: "#000", border: "#ccc", danger: "#f00", text: "#111", onPrimary: "#fff" },
      { disabled: false },
    );
    expect(btn.borderRadius).toBe("8px");
    expect(btn.fontSize).toBe("13.5px");
  });

  it("the metric is a card built from surface/border/radius/shadow tokens", () => {
    const card = metricCardStyle({ surface: "#fff", border: "#eee" }, sizing);
    expect(card).toMatchObject({
      background: "#fff",
      border: "1px solid #eee",
      borderRadius: "12px",
      boxShadow: "none",
      padding: "16px",
    });
    expect(metricLabelStyle("#888", sizing)).toMatchObject({ fontSize: "12.5px", color: "#888" });
    expect(metricValueStyle(sizing)).toMatchObject({ fontSize: "28px", fontWeight: 700 });
    expect(metricDeltaStyle("#0a0", sizing)).toMatchObject({
      fontSize: "12.5px",
      color: "#0a0",
      fontWeight: 600,
    });
  });

  it("spreadsheet header is muted/small/semibold with a 1px divider; cells use the space scale", () => {
    const th = spreadsheetThStyle({ headerBg: "#f8f8f8", border: "#eee", muted: "#666" }, sizing);
    expect(th).toMatchObject({
      background: "#f8f8f8",
      color: "#666",
      fontSize: "12.5px",
      fontWeight: 600,
      borderBottom: "1px solid #eee",
    });
    expect(spreadsheetTdStyle({ numeric: true }, sizing).padding).toBe("9px 12px");
    expect(spreadsheetPagerButtonStyle({ border: "#eee", accent: "#000" }, sizing).borderRadius).toBe("3px");
  });

  it("overlay, notices, text and chart caption follow the bag", () => {
    expect(dialogBoxStyle({ ...defaultLightTheme, "radius.lg": "20px" }, "#000").borderRadius).toBe("20px");
    expect(dialogBoxStyle(defaultLightTheme, "#000").boxShadow).toBe(defaultLightTheme["shadow.md"]);
    expect(toastStyle({ bg: "#fff", fg: "#000", border: "#eee" }, sizing).borderRadius).toBe("3px");
    expect(dataStateNoticeStyle({ bg: "#fff", fg: "#000" }, sizing)).toMatchObject({
      borderRadius: "3px",
      fontSize: "12.5px",
    });
    expect(textBodyStyle("#000", sizing)).toMatchObject({ color: "#000", fontSize: "14px", lineHeight: 1.7 });
    expect(textPreStyle("#f8f8f8", sizing).borderRadius).toBe("3px");
    expect(textCodeStyle("#f8f8f8", sizing).fontSize).toBe("12.5px");
    expect(loadingStyle("#888", sizing)).toMatchObject({ gap: "9px", fontSize: "14px" });
    expect(listEmptyStyle("#888", sizing).fontSize).toBe("14px");
    expect(chartCaptionStyle(sizing)).toMatchObject({ fontSize: "14px", fontWeight: 600 });
  });
});
