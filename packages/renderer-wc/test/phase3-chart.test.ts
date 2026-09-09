import type { BindingClient } from "@kohaku-ui/data-binding";
import type { TabularData } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import type { SurfaceEvent } from "../src/index.js";
import { buildSpec, byKohaku, mount, tick } from "./util.js";

function bindingWith(data: TabularData): BindingClient {
  return {
    async resolve() {
      return data;
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

const REF = "query://sales/monthly";

describe("Phase 3: presentChart", () => {
  it("bar emits a figure (aria-label) + aria-hidden SVG (rect) + visually hidden a11y table", async () => {
    const data: TabularData = {
      columns: [
        { key: "month", label: "Month", type: "string" },
        { key: "value", label: "Value", type: "number" },
      ],
      rows: [
        { month: "Jan", value: 100 },
        { month: "Feb", value: 240 },
        { month: "Mar", value: 180 },
      ],
      dataVersion: "v1",
    };
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        {
          id: "root",
          type: "presentChart",
          props: { kind: "bar", x: "month", y: "value", title: "Monthly sales" },
          data: { $ref: REF },
        },
      ],
    });
    const surface = mount(spec, { binding: bindingWith(data) });
    await tick();

    const figure = byKohaku(surface, "root")!;
    expect(figure.tagName).toBe("FIGURE");
    expect(figure.getAttribute("aria-label")).toBe("Monthly sales");
    expect(figure.querySelector("figcaption")!.textContent).toBe("Monthly sales");

    // The visual rendering is an aria-hidden SVG (bar emits rect)
    const holder = figure.querySelector('[aria-hidden="true"]')!;
    const svg = holder.querySelector("svg")!;
    expect(svg.querySelectorAll("rect").length).toBe(3);

    // An always visually hidden a11y table (clip pattern). Row contents match the data.
    const tables = figure.querySelectorAll("table");
    expect(tables.length).toBe(1);
    const a11y = tables[0]!;
    expect((a11y as HTMLElement).style.position).toBe("absolute");
    expect(a11y.querySelector("caption")!.textContent).toBe("Monthly sales");
    const bodyRows = [...a11y.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent),
    );
    expect(bodyRows).toEqual([
      ["Jan", "100"],
      ["Feb", "240"],
      ["Mar", "180"],
    ]);
  });

  it("series pivots long→wide and series are sorted in numeric natural order", async () => {
    const data: TabularData = {
      columns: [
        { key: "month", type: "string" },
        { key: "region", type: "string" },
        { key: "value", type: "number" },
      ],
      rows: [
        { month: "Jan", region: "10", value: 5 },
        { month: "Jan", region: "2", value: 7 },
      ],
      dataVersion: "v1",
    };
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        {
          id: "root",
          type: "presentChart",
          props: { kind: "line", x: "month", y: "value", series: "region" },
          data: { $ref: REF },
        },
      ],
    });
    const surface = mount(spec, { binding: bindingWith(data) });
    await tick();
    const figure = byKohaku(surface, "root")!;
    // line emits one polyline per series (2 series).
    expect(figure.querySelectorAll("svg polyline").length).toBe(2);
    // The a11y table's column headers are in numeric natural order ("2" < "10").
    const headers = [...figure.querySelectorAll("thead th")].map((th) => th.textContent);
    expect(headers).toEqual(["month", "2", "10"]);
  });

  it("pie uses no hand-drawn SVG: a visible fallback table + visually hidden a11y table", async () => {
    const data: TabularData = {
      columns: [
        { key: "cat", type: "string" },
        { key: "value", type: "number" },
      ],
      rows: [
        { cat: "A", value: 3 },
        { cat: "B", value: 7 },
      ],
      dataVersion: "v1",
    };
    const spec = buildSpec({
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        {
          id: "root",
          type: "presentChart",
          props: { kind: "pie", x: "cat", y: "value" },
          data: { $ref: REF },
        },
      ],
    });
    const surface = mount(spec, { binding: bindingWith(data) });
    await tick();
    const figure = byKohaku(surface, "root")!;
    // No SVG (not a hand-drawn kind).
    expect(figure.querySelector("svg")).toBeNull();
    // Two tables: the visible fallback table + the a11y table.
    const tables = [...figure.querySelectorAll("table")];
    expect(tables.length).toBe(2);
    // The first is visible (not clipped), the second is visually hidden.
    expect((tables[0] as HTMLElement).style.position).not.toBe("absolute");
    expect((tables[1] as HTMLElement).style.position).toBe("absolute");
  });
});

// ---- pointClick (data-point click) + referenceLines (reference lines) ----

const MONTHLY: TabularData = {
  columns: [
    { key: "month", type: "string" },
    { key: "value", type: "number" },
  ],
  rows: [
    { month: "Jan", value: 100 },
    { month: "Feb", value: 240 },
    { month: "Mar", value: 180 },
  ],
  dataVersion: "v1",
};

const LONG: TabularData = {
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

const REF2 = "query://sales/monthly";

/** Builds the spec for a bar chart that declares pointClick (props/data are replaceable). */
function pointSpec(
  props: Record<string, unknown>,
  events: unknown[] = [
    { on: "root.pointClick", emit: "intent.patch", payload: { month: "$row.month", value: "$row.value" } },
  ],
) {
  return buildSpec({
    dataVersion: "v1",
    refVersions: { [REF2]: "v1" },
    components: [{ id: "root", type: "presentChart", props, data: { $ref: REF2 } }],
    events,
  });
}

async function mountPoint(spec: ReturnType<typeof pointSpec>, data: TabularData) {
  const events: SurfaceEvent[] = [];
  const surface = mount(spec, { binding: bindingWith(data), onEvent: (e) => events.push(e) });
  await tick();
  return { surface, events };
}

describe("presentChart pointClick", () => {
  it("clicking a bar's rect forwards with a $row-resolved payload", async () => {
    const spec = pointSpec({ kind: "bar", x: "month", y: "value" });
    const { surface, events } = await mountPoint(spec, MONTHLY);
    const rects = byKohaku(surface, "root")!.querySelectorAll("svg rect");
    expect(rects.length).toBe(3);
    rects[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events).toEqual([
      {
        componentId: "root",
        on: "root.pointClick",
        emit: "intent.patch",
        payload: { month: "Feb", value: 240 },
      },
    ]);
  });

  it("a bar can trigger pointClick via keyboard (Enter / Space) (role=button + tabindex)", async () => {
    const spec = pointSpec({ kind: "bar", x: "month", y: "value" });
    const { surface, events } = await mountPoint(spec, MONTHLY);
    const rect = byKohaku(surface, "root")!.querySelectorAll("svg rect")[0]!;
    expect(rect.getAttribute("role")).toBe("button");
    expect(rect.getAttribute("tabindex")).toBe("0");
    expect(rect.getAttribute("aria-label")).toContain("Jan");

    rect.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    rect.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(events).toHaveLength(2);
    expect(events[0]!.payload).toEqual({ month: "Jan", value: 100 });
    expect(events[1]!.payload).toEqual({ month: "Jan", value: 100 });
  });

  it("line draws clickable dots (circle) and forwards on point click", async () => {
    const spec = pointSpec({ kind: "line", x: "month", y: "value" });
    const { surface, events } = await mountPoint(spec, MONTHLY);
    const svg = byKohaku(surface, "root")!.querySelector("svg")!;
    const circles = svg.querySelectorAll("circle");
    expect(circles.length).toBe(3); // a dot on each point
    circles[2]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events).toEqual([
      {
        componentId: "root",
        on: "root.pointClick",
        emit: "intent.patch",
        payload: { month: "Mar", value: 180 },
      },
    ]);
  });

  it("series resolves the long form { x, series, y } as $row", async () => {
    const spec = pointSpec({ kind: "bar", x: "month", y: "value", series: "region" }, [
      {
        on: "root.pointClick",
        emit: "intent.patch",
        payload: { month: "$row.month", region: "$row.region", value: "$row.value" },
      },
    ]);
    const { surface, events } = await mountPoint(spec, LONG);
    // yKeys are in numeric natural order ["north","south"]. Grouped bars are ordered {north, south} for the first month, then {north, south} for the second month.
    const rects = byKohaku(surface, "root")!.querySelectorAll("svg rect");
    rects[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events).toEqual([
      {
        componentId: "root",
        on: "root.pointClick",
        emit: "intent.patch",
        payload: { month: "Jan", region: "north", value: 10 },
      },
    ]);
  });

  it("without pointClick declared it is non-interactive (SVG is aria-hidden, rect has no role/tabindex)", async () => {
    const spec = pointSpec({ kind: "bar", x: "month", y: "value" }, []);
    const { surface, events } = await mountPoint(spec, MONTHLY);
    const holder = byKohaku(surface, "root")!.querySelector('[aria-hidden="true"]');
    expect(holder).not.toBeNull(); // when non-interactive, the holder is aria-hidden
    const rect = byKohaku(surface, "root")!.querySelector("svg rect")!;
    expect(rect.getAttribute("role")).toBeNull();
    expect(rect.getAttribute("tabindex")).toBeNull();
    rect.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(events).toEqual([]);
  });

  it("when interactive, removes the holder's aria-hidden and gives role=group + aria-label", async () => {
    const spec = pointSpec({ kind: "bar", x: "month", y: "value", title: "Monthly" });
    const { surface } = await mountPoint(spec, MONTHLY);
    const figure = byKohaku(surface, "root")!;
    // When interactive, there is no aria-hidden holder.
    expect(figure.querySelector('[aria-hidden="true"]')).toBeNull();
    const group = figure.querySelector('[role="group"]')!;
    expect(group).not.toBeNull();
    expect(group.getAttribute("aria-label")).toBe("Monthly");
  });
});

describe("presentChart referenceLines", () => {
  it("declaring a reference line draws a dashed line + label in the SVG and the axis extends to the reference value", async () => {
    // The reference line 300 exceeds the data max of 240. Like extendDomain, include it in the max (bars shrink and the reference line becomes visible).
    const spec = pointSpec(
      { kind: "bar", x: "month", y: "value", referenceLines: [{ value: 300, label: "Target" }] },
      [],
    );
    const { surface } = await mountPoint(spec, MONTHLY);
    const svg = byKohaku(surface, "root")!.querySelector("svg")!;
    const dashed = [...svg.querySelectorAll("line")].filter(
      (l) => l.getAttribute("stroke-dasharray") === "4 4",
    );
    expect(dashed.length).toBe(1);
    const labels = [...svg.querySelectorAll("text")].map((t) => t.textContent);
    expect(labels).toContain("Target");
  });
});
