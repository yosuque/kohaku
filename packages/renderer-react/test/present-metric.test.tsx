import type { BindingClient } from "@kohaku-ui/data-binding";
import {
  type JsonObject,
  parseSpec,
  type TabularData,
  type ThemeTokens,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;
const REF = "query://ledger/kpi";

function binding(row: JsonObject): BindingClient {
  const data: TabularData = {
    columns: [
      { key: "revenue", label: "Sales", type: "number" },
      { key: "growth", label: "Growth", type: "number" },
    ],
    rows: [row],
    dataVersion: "v1",
  };
  return {
    async resolve() {
      return data;
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

function metricSpec(props: Record<string, unknown>): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["metric1"] },
      { id: "metric1", type: "presentMetric", props, data: { $ref: REF } },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

function renderMetric(
  props: Record<string, unknown>,
  row: JsonObject,
  theme: ThemeTokens = {},
  locale?: string,
) {
  return render(
    <RendererProvider
      value={{
        impls: createCoreRegistry(),
        binding: binding(row),
        theme,
        ...(locale != null ? { locale } : {}),
      }}
    >
      <SpecView spec={metricSpec(props)} />
    </RendererProvider>,
  );
}

const el = () => document.querySelector('[data-kohaku="metric1"]') as HTMLElement;

describe("presentMetric", () => {
  it("formats the first row value by locale and shows the change as ▲ + signed value", async () => {
    renderMetric(
      { label: "Sales", valueColumn: "revenue", deltaColumn: "growth", format: "number", unit: "yen" },
      { revenue: 120000000, growth: 12 },
    );
    await waitFor(() => expect(screen.getByText("120,000,000yen")).toBeDefined());
    // Increase shows ▲ + signed value
    expect(screen.getByText("▲ +12yen")).toBeDefined();
  });

  it("a decrease is shown as ▼ + negative value", async () => {
    renderMetric(
      { label: "Sales", valueColumn: "revenue", deltaColumn: "growth", format: "number" },
      { revenue: 500, growth: -5 },
    );
    await waitFor(() => expect(screen.getByText("500")).toBeDefined());
    expect(screen.getByText("▼ -5")).toBeDefined();
  });

  it("composes value and period-over-period change (with direction phrase) into aria-label", async () => {
    renderMetric(
      { label: "Sales", valueColumn: "revenue", deltaColumn: "growth", format: "number", unit: "yen" },
      { revenue: 120000000, growth: 12 },
    );
    await waitFor(() => expect(screen.getByText("120,000,000yen")).toBeDefined());
    expect(el().getAttribute("aria-label")).toBe("Sales: 120,000,000yen, change +12yen (up)");
  });

  it("without deltaColumn, no change is shown and aria-label carries only the value", async () => {
    renderMetric({ label: "Count", valueColumn: "revenue", format: "number" }, { revenue: 42 });
    await waitFor(() => expect(screen.getByText("42")).toBeDefined());
    expect(el().getAttribute("aria-label")).toBe("Count: 42");
    expect(screen.queryByText(/▲|▼/)).toBeNull();
  });

  it("format=currency formats with a currency symbol (default currency code JPY)", async () => {
    renderMetric(
      { label: "Sales", valueColumn: "revenue", format: "currency" },
      { revenue: 120000000 },
      {},
      "ja-JP",
    );
    // Use the same Intl formatting as the render side for the expected value (does not depend on the ICU version).
    const jpy = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(120000000);
    await waitFor(() => expect(screen.getByText(jpy)).toBeDefined());
    // Different from number formatting (no symbol) = a currency symbol is included
    expect(jpy).not.toBe((120000000).toLocaleString("ja-JP"));
    expect(screen.queryByText("120,000,000")).toBeNull();
  });

  it("the currency prop sets the currency code and formats with a symbol different from the default JPY", async () => {
    renderMetric(
      { label: "Sales", valueColumn: "revenue", format: "currency", currency: "USD" },
      { revenue: 1500 },
      {},
      "ja-JP",
    );
    const usd = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "USD" }).format(1500);
    const jpy = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(1500);
    await waitFor(() => expect(screen.getByText(usd)).toBeDefined());
    expect(usd).not.toBe(jpy);
  });

  it("with format=currency the change is also currency-formatted", async () => {
    renderMetric(
      { label: "Sales", valueColumn: "revenue", deltaColumn: "growth", format: "currency" },
      { revenue: 120000000, growth: 3000000 },
      {},
      "ja-JP",
    );
    const money = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(3000000);
    await waitFor(() => expect(screen.getByText(`▲ +${money}`)).toBeDefined());
  });

  it("an invalid currency code (outside ISO 4217) falls back to thousands separators instead of throwing", async () => {
    // "ZZ" is not 3 letters, so Intl.NumberFormat throws a RangeError.
    // If the fallback works, it displays a thousands-separated number without a currency symbol and rendering does not crash.
    renderMetric(
      { label: "Sales", valueColumn: "revenue", format: "currency", currency: "ZZ" },
      { revenue: 1000000 },
      {},
      "ja-JP",
    );
    await waitFor(() => expect(screen.getByText((1000000).toLocaleString("ja-JP"))).toBeDefined());
  });

  it('delta=0 renders as flat (symbol "—" / muted color)', async () => {
    renderMetric(
      { label: "Sales", valueColumn: "revenue", deltaColumn: "growth", format: "number" },
      { revenue: 500, growth: 0 },
      { "color.muted": "rgb(10, 10, 10)" },
    );
    const delta = await screen.findByText("— 0");
    // flat uses muted rather than a change color. The direction symbol is "—" instead of ▲/▼.
    expect(delta.style.color).toBe("rgb(10, 10, 10)");
    // The aria-label appends only the value without a direction phrase (metricDelta's flat branch).
    expect(el().getAttribute("aria-label")).toBe("Sales: 500, change 0");
  });

  it("with positiveIsGood=false an increase is shown in the negative color (inverted)", async () => {
    renderMetric(
      {
        label: "Cost",
        valueColumn: "revenue",
        deltaColumn: "growth",
        format: "number",
        positiveIsGood: false,
      },
      { revenue: 500, growth: 12 },
      { "color.positive": "rgb(0, 200, 0)", "color.negative": "rgb(200, 0, 0)" },
    );
    // An increase (▲ +12), but because positiveIsGood=false it is the "bad direction" = negative color.
    const delta = await screen.findByText("▲ +12");
    expect(delta.style.color).toBe("rgb(200, 0, 0)");
  });
});
