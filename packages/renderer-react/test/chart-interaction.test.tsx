// presentChart's data-point click (pointClick) + reference lines (referenceLines).
// Recharts' ResponsiveContainer renders the child chart at 0x0 in jsdom, so replace it with a mock that injects
// fixed dimensions to render the inner chart (real SVG), and verify the bar/dot onClick with a real click.

import type { BindingClient } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("recharts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Pass fixed width/height to the child chart so real SVG renders even in jsdom (does not change production's measured rendering).
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: 600,
            height: 320,
          })
        : children,
  };
});

import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const REF = "query://sales/x";
const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "test", cache: "hit" } as const;

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

// long-format data for series pivot (month × region → value).
const LONG_DATA: TabularData = {
  columns: [
    { key: "month", type: "string" },
    { key: "region", type: "string" },
    { key: "value", type: "number" },
  ],
  rows: [
    { month: "Jan", region: "north", value: 10 },
    { month: "Jan", region: "south", value: 20 },
    { month: "Feb", region: "north", value: 30 },
    { month: "Feb", region: "south", value: 40 },
  ],
  dataVersion: "v1",
};

function binding(data: TabularData): BindingClient {
  return {
    async resolve() {
      return data;
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

function chartSpec(props: Record<string, unknown>, events: unknown[]): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["c1"] },
      { id: "c1", type: "presentChart", props, data: { $ref: REF } },
    ],
    events,
    provenance: PROVENANCE,
  });
}

function mount(spec: UISpec, data: TabularData, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), binding: binding(data), theme: {}, onEvent }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("presentChart: pointClick (data point click)", () => {
  it("clicking a bar forwards pointClick with a $row-resolved payload", async () => {
    const events: SurfaceEvent[] = [];
    const spec = chartSpec({ kind: "bar", x: "region", y: "revenue" }, [
      {
        on: "c1.pointClick",
        emit: "intent.patch",
        payload: { drilldown: "$row.region", amount: "$row.revenue" },
      },
    ]);
    const { container } = mount(spec, DATA, (e) => events.push(e));
    await waitFor(() => expect(container.querySelector(".recharts-bar-rectangle")).toBeTruthy());

    fireEvent.click(container.querySelectorAll(".recharts-bar-rectangle")[0]!);
    expect(events).toEqual([
      {
        componentId: "c1",
        on: "c1.pointClick",
        emit: "intent.patch",
        payload: { drilldown: "japan", amount: 100 },
      },
    ]);
  });

  it("clicking a line dot forwards pointClick (dots render only when clickable)", async () => {
    const events: SurfaceEvent[] = [];
    const spec = chartSpec({ kind: "line", x: "region", y: "revenue" }, [
      { on: "c1.pointClick", emit: "intent.replace", payload: { r: "$row.region" } },
    ]);
    const { container } = mount(spec, DATA, (e) => events.push(e));
    await waitFor(() => expect(container.querySelector("circle")).toBeTruthy());

    const dots = container.querySelectorAll("circle");
    expect(dots.length).toBe(2); // 2 data points
    fireEvent.click(dots[1]!);
    expect(events).toEqual([
      { componentId: "c1", on: "c1.pointClick", emit: "intent.replace", payload: { r: "usa" } },
    ]);
  });

  it("a bar with series resolves the long form { x, series, y } as $row", async () => {
    const events: SurfaceEvent[] = [];
    const spec = chartSpec({ kind: "bar", x: "month", y: "value", series: "region" }, [
      {
        on: "c1.pointClick",
        emit: "intent.patch",
        payload: { month: "$row.month", region: "$row.region", value: "$row.value" },
      },
    ]);
    const { container } = mount(spec, LONG_DATA, (e) => events.push(e));
    await waitFor(() => expect(container.querySelector(".recharts-bar-rectangle")).toBeTruthy());

    // yKeys are in series numeric order ["north","south"]. Target the north series for the first month.
    // Recharts draws bars grouped by series, so the leading rectangle is the north series' first month.
    fireEvent.click(container.querySelectorAll(".recharts-bar-rectangle")[0]!);
    expect(events).toEqual([
      {
        componentId: "c1",
        on: "c1.pointClick",
        emit: "intent.patch",
        payload: { month: "Jan", region: "north", value: 10 },
      },
    ]);
  });

  it("if pointClick is undeclared it is non-interactive (no dots and no onClick)", async () => {
    const events: SurfaceEvent[] = [];
    const spec = chartSpec({ kind: "line", x: "region", y: "revenue" }, []);
    const { container } = mount(spec, DATA, (e) => events.push(e));
    await waitFor(() => expect(container.querySelector('[data-kohaku="c1"]')).toBeTruthy());
    // Instead of a fixed sleep, drain the event loop multiple times so any delayed firing is surely reached before verifying emptiness
    // (the same determinization pattern as sandbox/test/mount.test.ts).
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    // An undeclared line does not render dots (dot=false).
    expect(container.querySelectorAll("circle").length).toBe(0);
    expect(events).toEqual([]);
  });

  it("pie/scatter do not wire pointClick (aligned with WC's table fallback across renderers)", async () => {
    const events: SurfaceEvent[] = [];
    const spec = chartSpec({ kind: "pie", x: "region", y: "revenue" }, [
      { on: "c1.pointClick", emit: "intent.patch", payload: { r: "$row.region" } },
    ]);
    const { container } = mount(spec, DATA, (e) => events.push(e));
    await waitFor(() => expect(container.querySelector('[data-kohaku="c1"]')).toBeTruthy());
    // Even clicking a Recharts pie sector emits nothing because onClick is not wired.
    const sector = container.querySelector(".recharts-pie-sector, .recharts-sector");
    if (sector != null) fireEvent.click(sector);
    expect(events).toEqual([]);
  });
});

describe("presentChart: referenceLines (reference lines)", () => {
  it("declaring referenceLines renders Recharts' ReferenceLine", async () => {
    const spec = chartSpec(
      {
        kind: "bar",
        x: "region",
        y: "revenue",
        referenceLines: [{ value: 150, label: "Target" }, { value: 250 }],
      },
      [],
    );
    const { container } = mount(spec, DATA);
    await waitFor(() => expect(container.querySelector(".recharts-bar-rectangle")).toBeTruthy());
    expect(container.querySelectorAll(".recharts-reference-line").length).toBe(2);
  });
});
