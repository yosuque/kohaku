import type { BindingClient } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const REF = "query://ledger/x";
const PROVENANCE = { tier: "L1", composedBy: "test", cache: "hit" } as const;
const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;

const DATA: TabularData = {
  columns: [
    { key: "region", label: "Region", type: "string" },
    { key: "revenue", label: "Revenue", type: "number" },
  ],
  rows: [
    { region: "japan", revenue: 100 },
    { region: "usa", revenue: 200 },
  ],
  dataVersion: "v1",
};

function okBinding(): BindingClient {
  return {
    async resolve() {
      return DATA;
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

function failBinding(): BindingClient {
  return {
    async resolve() {
      throw new Error("Failed to fetch data");
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

function chartSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["c1"] },
      {
        id: "c1",
        type: "presentChart",
        props: { kind: "bar", x: "region", y: "revenue", title: "Sales by region" },
        data: { $ref: REF },
      },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

function sheetSpec(clickable: boolean): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["t1"] },
      { id: "t1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
    ],
    events: clickable ? [{ on: "t1.rowClick", emit: "intent.patch", payload: { r: "$row.region" } }] : [],
    provenance: PROVENANCE,
  });
}

function errorSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["t1"] },
      { id: "t1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

function renderSpec(spec: UISpec, binding: BindingClient, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {}, onEvent }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("a11y phase 1", () => {
  it("PresentChart has figure + aria-label (title)", async () => {
    renderSpec(chartSpec(), okBinding());
    await waitFor(() => expect(screen.getByRole("figure", { name: "Sales by region" })).toBeDefined());
  });

  it("PresentChart's data table alternative is readable by assistive tech (not treated as hidden)", async () => {
    renderSpec(chartSpec(), okBinding());
    // Since role="img" was removed, the visually hidden data table remains in the accessibility tree.
    // The caption (= the same label as aria-label) becomes the table's accessible name.
    const table = await screen.findByRole("table", { name: "Sales by region" });
    expect(within(table).getByText("japan")).toBeDefined();
    expect(within(table).getByText("usa")).toBeDefined();
  });

  it("a sortable header transitions aria-sort from descending → ascending on click", async () => {
    renderSpec(sheetSpec(false), okBinding());
    const header = () => screen.getByRole("columnheader", { name: "Region" });
    await waitFor(() => expect(header()).toBeDefined());

    // Initially unsorted (aria-sort not set)
    expect(header().getAttribute("aria-sort")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Region" }));
    expect(header().getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(screen.getByRole("button", { name: "Region" }));
    expect(header().getAttribute("aria-sort")).toBe("ascending");
  });

  it("a row emits rowClick via keyboard (Enter)", async () => {
    const events: SurfaceEvent[] = [];
    renderSpec(sheetSpec(true), okBinding(), (e) => events.push(e));
    const sheet = () => within(document.querySelector('[data-kohaku="t1"]') as HTMLElement);
    await waitFor(() => expect(sheet().getByText("japan")).toBeDefined());

    const row = sheet().getByText("japan").closest("tr") as HTMLElement;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(row, { key: "Enter" });
    expect(events).toEqual([
      { componentId: "t1", on: "t1.rowClick", emit: "intent.patch", payload: { r: "japan" } },
    ]);
  });

  it("a data fetch error is surfaced with role=alert", async () => {
    renderSpec(errorSpec(), failBinding());
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Failed to fetch data");
    });
  });
});
