import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

// presentSpreadsheet's sortChange (in-column sort toggle) and cellEdit (editable cells) events.
// Both use renderer-core (nextSortState / applyLocalView / coerceCellInput / commitCellEdit) as the
// single source of truth; these tests pin the React-side wiring (governance gating, payload shape,
// and — for cellEdit — the invoke path / optimistic display).

const REF = "query://sales/records";

function tableData(rows: TabularData["rows"]): TabularData {
  return {
    columns: [
      { key: "region", label: "Region", type: "string" },
      { key: "revenue", label: "Revenue", type: "number" },
    ],
    rows,
    dataVersion: "v1",
  };
}

function spec(props: Record<string, unknown>, events: unknown[] = []): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    refVersions: { [REF]: "v1" },
    components: [{ id: "root", type: "presentSpreadsheet", props, data: { $ref: REF } }],
    events,
    provenance: { tier: "L0", composedBy: "test", cache: "hit" },
  });
}

function fakeBinding(rows: TabularData["rows"], onResolve?: (opts?: ResolveOptions) => void): BindingClient {
  return {
    async resolve(_ref, opts) {
      onResolve?.(opts);
      return tableData(rows);
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

const ROWS = [
  { region: "japan", revenue: 2 },
  { region: "us", revenue: 1 },
];

function renderSpreadsheet(uiSpec: UISpec, binding: BindingClient, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {}, onEvent }}>
      <SpecView spec={uiSpec} />
    </RendererProvider>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("presentSpreadsheet: sortChange", () => {
  it("emits sortChange with { value: { field, dir } } on each toggle (desc then asc), gated by declaration", async () => {
    const events: SurfaceEvent[] = [];
    const uiSpec = spec({}, [{ on: "root.sortChange", emit: "intent.patch", payload: { value: "$value" } }]);
    renderSpreadsheet(uiSpec, fakeBinding(ROWS), (e) => events.push(e));
    const revenueBtn = await screen.findByText("Revenue");

    fireEvent.click(revenueBtn);
    await flush();
    fireEvent.click(revenueBtn);
    await flush();

    expect(events).toEqual([
      {
        componentId: "root",
        on: "root.sortChange",
        emit: "intent.patch",
        payload: { value: { field: "revenue", dir: "desc" } },
      },
      {
        componentId: "root",
        on: "root.sortChange",
        emit: "intent.patch",
        payload: { value: { field: "revenue", dir: "asc" } },
      },
    ]);
  });

  it("drops sortChange when undeclared (governance), while sort still applies locally", async () => {
    const events: SurfaceEvent[] = [];
    const uiSpec = spec({});
    renderSpreadsheet(uiSpec, fakeBinding(ROWS), (e) => events.push(e));
    const revenueBtn = await screen.findByText("Revenue");

    fireEvent.click(revenueBtn);
    await flush();

    expect(events).toEqual([]);
    // The sort still took effect locally (revenue desc: japan=2 first).
    const firstRow = document.querySelector('[data-kohaku="root"] tbody tr');
    expect(firstRow?.textContent).toContain("japan");
  });

  it("never emits sortChange from Spec-driven declared-sort delivery (only from a user toggle)", async () => {
    const events: SurfaceEvent[] = [];
    const uiSpec = spec({ sortBy: { field: "revenue", dir: "asc" } }, [
      { on: "root.sortChange", emit: "intent.patch", payload: { value: "$value" } },
    ]);
    renderSpreadsheet(uiSpec, fakeBinding(ROWS), (e) => events.push(e));
    await screen.findByText("Revenue");
    await flush();
    expect(events).toEqual([]);
  });

  it("serverSide: toggling sort re-fetches with the same sort argument in both cases and emits once", async () => {
    const seenOpts: (ResolveOptions | undefined)[] = [];
    const events: SurfaceEvent[] = [];
    const uiSpec = spec({ serverSide: true, pageSize: 2 }, [
      { on: "root.sortChange", emit: "intent.patch", payload: { value: "$value" } },
    ]);
    renderSpreadsheet(
      uiSpec,
      fakeBinding(ROWS, (opts) => seenOpts.push(opts)),
      (e) => events.push(e),
    );
    await screen.findByText("Revenue");
    await flush();

    const revenueBtn = screen.getByText("Revenue");
    fireEvent.click(revenueBtn);
    await flush();

    expect(events).toEqual([
      {
        componentId: "root",
        on: "root.sortChange",
        emit: "intent.patch",
        payload: { value: { field: "revenue", dir: "desc" } },
      },
    ]);
    const sortCall = seenOpts.find((o) => o?.sort != null);
    expect(sortCall?.sort).toEqual({ key: "revenue", dir: "desc" });
  });
});
