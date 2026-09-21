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
  dialogCloseButtonStyle,
  dialogDescriptionStyle,
  dialogHeaderStyle,
  dialogOverlayStyle,
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
  spreadsheetCellEditInputStyle,
  spreadsheetFooterBarStyle,
  spreadsheetFooterTotalStyle,
  spreadsheetPagerButtonStyle,
  spreadsheetSortButtonStyle,
  spreadsheetTdStyle,
  spreadsheetThStyle,
  tabButtonStyle,
  textBodyStyle,
  textCodeStyle,
  textHeadingStyle,
  textListStyle,
  textPreStyle,
  textSubheadingStyle,
  toastDismissButtonStyle,
  toastStyle,
} from "../../src/index.js";

const sizing = resolveSizing({
  "radius.sm": "6px",
  "radius.md": "3px",
  "radius.lg": "22px",
  "space.2": "9px",
  "space.3": "11px",
  "space.4": "17px",
  "font.size.md": "14px",
  "font.size.sm": "12px",
  "font.size.xl": "19px",
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
    expect(dialogBoxStyle(defaultLightTheme, "#000", defaults).maxHeight).toBe(
      `calc(100vh - ${defaults.space6})`,
    );
    expect(dialogOverlayStyle(defaultLightTheme, sizing)).toMatchObject({
      padding: "17px",
      background: defaultLightTheme["color.scrim"],
    });
    expect(dialogHeaderStyle(sizing).gap).toBe("11px");
    expect(dialogTitleStyle("#000", sizing)).toMatchObject({ fontSize: defaults.fontLg, fontWeight: 700 });
    expect(toastStyle({ bg: "#fff", fg: "#000", border: "#eee" }, sizing).borderRadius).toBe("3px");
    expect(toastStyle({ bg: "#fff", fg: "#000", border: "#eee" }, sizing).bottom).toBe(sizing.space5);
    expect(toastDismissButtonStyle(sizing).fontSize).toBe(sizing.fontLg);
    expect(dataStateNoticeStyle({ bg: "#fff", fg: "#000" }, sizing)).toMatchObject({
      borderRadius: "3px",
      fontSize: "12px",
    });
    expect(textHeadingStyle("#111")).toEqual({ margin: 0, color: "#111", fontWeight: 650, lineHeight: 1.3 });
    expect(textBodyStyle("#000", sizing)).toMatchObject({ color: "#000", fontSize: "14px", lineHeight: 1.7 });
    expect(textListStyle(sizing).paddingLeft).toBe(sizing.space5);
    expect(textPreStyle("#f8f8f8", sizing).borderRadius).toBe("3px");
    expect(textCodeStyle("#f8f8f8", sizing).fontSize).toBe("12px");
    expect(textCodeStyle("#f8f8f8", sizing).padding).toBe(`1px ${sizing.space1}`);
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

  // m-18: these five presenter style functions had no test anywhere in the repo (a sixth, textListStyle,
  // already had one above). Each assertion below targets a sizing key that the override bag sets to a
  // value distinct from its default (adding radius.sm / font.size.xl to the bag for this purpose), so a
  // presenter that read the wrong key, or fell back to DEFAULT_SIZING, would produce a different literal
  // than the one asserted here.
  it("the spreadsheet footer/cell-edit, dialog close/description and text subheading presenters also read the bag", () => {
    expect(spreadsheetFooterTotalStyle({ muted: "#666" }, sizing)).toMatchObject({
      fontSize: "12px",
      color: "#666",
      padding: "9px 2px",
    });
    expect(spreadsheetCellEditInputStyle({ border: "#eee" }, { numeric: false }, sizing).borderRadius).toBe(
      "6px",
    );
    expect(dialogCloseButtonStyle(defaultLightTheme, sizing)).toMatchObject({
      fontSize: "19px",
      color: defaultLightTheme["color.muted"],
    });
    expect(dialogDescriptionStyle(defaultLightTheme, sizing)).toMatchObject({
      fontSize: "14px",
      color: defaultLightTheme["color.muted"],
    });
    // textSubheadingStyle's margin is built from two different sizing keys (space.2 then space.1), so it
    // gets its own override pair (distinct from the shared `sizing` bag's un-overridden space.1, which
    // other assertions above rely on staying at its default) to prove both halves come from the right key.
    const subheadingSizing = resolveSizing({ "space.1": "6px", "space.2": "13px" });
    expect(textSubheadingStyle(subheadingSizing).margin).toBe("13px 0 6px");
  });
});
