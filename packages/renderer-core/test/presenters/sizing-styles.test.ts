import { describe, expect, it } from "vitest";
import {
  actionButtonStyle,
  chartCaptionStyle,
  chartTableStyle,
  controlSelectStyle,
  DEFAULT_SIZING,
  dataStateNoticeStyle,
  defaultLightTheme,
  dialogBoxStyle,
  dialogTitleStyle,
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
  renderFailureNoticeStyle,
  resolveSizing,
  spreadsheetFooterBarStyle,
  spreadsheetPagerButtonStyle,
  spreadsheetSortButtonStyle,
  spreadsheetTdStyle,
  spreadsheetThStyle,
  tabButtonStyle,
  textBodyStyle,
  textCodeStyle,
  textHeadingStyle,
  textPreStyle,
  toastStyle,
} from "../../src/index.js";

const sizing = resolveSizing({
  "radius.md": "3px",
  "radius.lg": "22px",
  "space.2": "9px",
  "space.3": "11px",
  "space.4": "17px",
  "font.size.md": "14px",
  "font.size.sm": "12px",
  "font.size.2xl": "31px",
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
    expect(btn.padding).toBe("9px 17px");
    expect(btn.fontSize).toBe("14px");
    expect(btn.fontWeight).toBe(600);
    expect(tabButtonStyle({ accent: "#000", muted: "#888" }, { active: true }, sizing).fontSize).toBe("14px");
    expect(formControlBaseStyle("#ccc", sizing).borderRadius).toBe("3px");
    expect(formSubmitButtonStyle("#000", "#fff", { busy: false }, sizing).borderRadius).toBe("3px");
    expect(formRootStyle(sizing).gap).toBe("11px");
    expect(fieldRowStyle(sizing).fontSize).toBe("12px");
    expect(controlSelectStyle("#ccc", sizing).borderRadius).toBe("3px");
  });

  it("passing DEFAULT_SIZING explicitly reproduces the default-light values (external call sites migrating to required sizing)", () => {
    const btn = actionButtonStyle(
      "primary",
      { primary: "#000", border: "#ccc", danger: "#f00", text: "#111", onPrimary: "#fff" },
      { disabled: false },
      DEFAULT_SIZING,
    );
    expect(btn.borderRadius).toBe("8px");
    expect(btn.fontSize).toBe("13.5px");
  });

  it("the metric is a card built from surface/border/radius/shadow tokens", () => {
    const card = metricCardStyle({ surface: "#fff", border: "#eee" }, sizing);
    expect(card).toMatchObject({
      background: "#fff",
      border: "1px solid #eee",
      borderRadius: "22px",
      boxShadow: "none",
      padding: "17px",
    });
    expect(metricLabelStyle("#888", sizing)).toMatchObject({ fontSize: "12px", color: "#888" });
    expect(metricValueStyle(sizing)).toMatchObject({ fontSize: "31px", fontWeight: 700 });
    expect(metricDeltaStyle("#0a0", sizing)).toMatchObject({
      fontSize: "12px",
      color: "#0a0",
      fontWeight: 600,
    });
  });

  it("spreadsheet header is muted/small/semibold with a 1px divider; cells use the space scale", () => {
    const th = spreadsheetThStyle({ headerBg: "#f8f8f8", border: "#eee", muted: "#666" }, sizing);
    expect(th).toMatchObject({
      background: "#f8f8f8",
      color: "#666",
      fontSize: "12px",
      fontWeight: 600,
      borderBottom: "1px solid #eee",
    });
    expect(spreadsheetTdStyle({ numeric: true }, sizing).padding).toBe("9px 11px");
    const pager = spreadsheetPagerButtonStyle({ border: "#eee", accent: "#000" }, sizing);
    expect(pager.borderRadius).toBe("3px");
    expect(pager.padding).toBe("4px 11px");
    expect(pager.fontSize).toBe("12px");
    const sortBtn = spreadsheetSortButtonStyle({ numeric: false }, sizing);
    expect(sortBtn.padding).toBe("9px 11px");
    expect(sortBtn.gap).toBe("4px");
    const footer = spreadsheetFooterBarStyle({ muted: "#666" }, sizing);
    expect(footer).toMatchObject({ gap: "9px", fontSize: "12px", color: "#666" });
  });

  it("overlay, notices, text and chart caption follow the bag", () => {
    // dialogBoxStyle reads radius/shadow from the pre-resolved `sizing` bag now (not from `theme`), so an
    // override must be resolved into `sizing` first for it to reach borderRadius (see m-4's theme+sizing split).
    expect(dialogBoxStyle({}, "#000", resolveSizing({ "radius.lg": "20px" })).borderRadius).toBe("20px");
    expect(dialogBoxStyle(defaultLightTheme, "#000", defaults).boxShadow).toBe(
      defaultLightTheme["shadow.md"],
    );
    expect(dialogTitleStyle("#000", sizing)).toMatchObject({ fontSize: defaults.fontLg, fontWeight: 700 });
    expect(toastStyle({ bg: "#fff", fg: "#000", border: "#eee" }, sizing).borderRadius).toBe("3px");
    expect(dataStateNoticeStyle({ bg: "#fff", fg: "#000" }, sizing)).toMatchObject({
      borderRadius: "3px",
      fontSize: "12px",
    });
    expect(textHeadingStyle("#111")).toEqual({ margin: 0, color: "#111", fontWeight: 650, lineHeight: 1.3 });
    expect(textBodyStyle("#000", sizing)).toMatchObject({ color: "#000", fontSize: "14px", lineHeight: 1.7 });
    expect(textPreStyle("#f8f8f8", sizing).borderRadius).toBe("3px");
    expect(textCodeStyle("#f8f8f8", sizing).fontSize).toBe("12px");
    expect(loadingStyle("#888", sizing)).toMatchObject({ gap: "9px", fontSize: "14px" });
    expect(listEmptyStyle("#888", sizing).fontSize).toBe("14px");
    expect(chartCaptionStyle(sizing)).toMatchObject({ fontSize: "14px", fontWeight: 600 });
    expect(chartTableStyle(sizing)).toEqual({
      width: "100%",
      borderCollapse: "collapse",
      fontSize: "14px",
    });
    expect(renderFailureNoticeStyle("#b91c1c", sizing)).toMatchObject({
      color: "#b91c1c",
      borderRadius: "3px",
      fontSize: "12px",
    });
  });
});
