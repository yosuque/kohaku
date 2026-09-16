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

describe("presentSpreadsheet: cellEdit (editable)", () => {
  it("editable=false renders plain cells (no edit buttons at all)", async () => {
    renderSpreadsheet(spec({ editable: false }), fakeBinding(ROWS));
    await screen.findByText("Revenue");
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(document.querySelector('[data-kohaku="root"] tbody td')?.textContent).toBe("japan");
  });

  it("idle cells render as a button with an aria-label naming the column", async () => {
    renderSpreadsheet(spec({ editable: true }), fakeBinding(ROWS));
    const btns = await screen.findAllByRole("button", { name: "Edit Revenue" });
    expect(btns).toHaveLength(2);
    expect(btns[0]?.textContent).toBe("2");
  });

  it("Enter commits: resolves $row/$value in the invoked payload and shows the new value optimistically", async () => {
    const invokes: { action: string; payload: unknown }[] = [];
    const binding: BindingClient = {
      async resolve() {
        return tableData(ROWS);
      },
      async invokeAction(action, payload) {
        invokes.push({ action, payload });
        return { result: null };
      },
    };
    const uiSpec = spec({ editable: true }, [
      {
        on: "root.cellEdit",
        emit: "action.invoke",
        payload: { action: "updateCell", row: "$row.region", column: "$value.column", value: "$value.value" },
      },
    ]);
    renderSpreadsheet(uiSpec, binding);
    const editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    const input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    expect(invokes).toEqual([
      { action: "updateCell", payload: { action: "updateCell", row: "japan", column: "revenue", value: 99 } },
    ]);
    expect(screen.getAllByRole("button", { name: "Edit Revenue" })[0]?.textContent).toBe("99");
  });

  it("intent.* cellEdit forwards to onEvent instead of invoking the binding", async () => {
    const events: SurfaceEvent[] = [];
    const uiSpec = spec({ editable: true }, [
      { on: "root.cellEdit", emit: "intent.patch", payload: { value: "$value" } },
    ]);
    renderSpreadsheet(uiSpec, fakeBinding(ROWS), (e) => events.push(e));
    const editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    const input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    expect(events).toEqual([
      {
        componentId: "root",
        on: "root.cellEdit",
        emit: "intent.patch",
        payload: { value: { column: "revenue", value: 99, previousValue: 2, rowIndex: 0 } },
      },
    ]);
  });

  it("undeclared cellEdit is dropped by governance, but the optimistic edit still displays locally", async () => {
    const uiSpec = spec({ editable: true });
    renderSpreadsheet(uiSpec, fakeBinding(ROWS));
    const editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    const input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(screen.getAllByRole("button", { name: "Edit Revenue" })[0]?.textContent).toBe("99");
  });

  it("number coercion failure keeps the input open with aria-invalid and never invokes", async () => {
    const invokes: unknown[] = [];
    const binding: BindingClient = {
      async resolve() {
        return tableData(ROWS);
      },
      async invokeAction(action, payload) {
        invokes.push({ action, payload });
        return { result: null };
      },
    };
    const uiSpec = spec({ editable: true }, [
      {
        on: "root.cellEdit",
        emit: "action.invoke",
        payload: { action: "updateCell", value: "$value.value" },
      },
    ]);
    renderSpreadsheet(uiSpec, binding);
    const editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    const input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.change(input, { target: { value: "not-a-number" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();

    expect(invokes).toEqual([]);
    const stillInput = screen.getByRole("textbox", { name: "Edit Revenue" });
    expect(stillInput.getAttribute("aria-invalid")).toBe("true");
  });

  it("Escape cancels without committing; a plain blur (no Enter/Escape) commits", async () => {
    const invokes: unknown[] = [];
    const binding: BindingClient = {
      async resolve() {
        return tableData(ROWS);
      },
      async invokeAction(action, payload) {
        invokes.push({ action, payload });
        return { result: null };
      },
    };
    const uiSpec = spec({ editable: true }, [
      {
        on: "root.cellEdit",
        emit: "action.invoke",
        payload: { action: "updateCell", value: "$value.value" },
      },
    ]);
    renderSpreadsheet(uiSpec, binding);

    // Escape: no commit.
    let editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    let input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await flush();
    expect(invokes).toEqual([]);
    expect(screen.getAllByRole("button", { name: "Edit Revenue" })[0]?.textContent).toBe("2");

    // Plain blur (click away): commits.
    editBtn = screen.getAllByRole("button", { name: "Edit Revenue" })[0]!;
    fireEvent.click(editBtn);
    input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.blur(input);
    await flush();
    expect(invokes).toEqual([{ action: "updateCell", payload: { action: "updateCell", value: 42 } }]);
    expect(screen.getAllByRole("button", { name: "Edit Revenue" })[0]?.textContent).toBe("42");
  });

  it("committing an unchanged value closes the cell without invoking", async () => {
    const invokes: unknown[] = [];
    const binding: BindingClient = {
      async resolve() {
        return tableData(ROWS);
      },
      async invokeAction(action, payload) {
        invokes.push({ action, payload });
        return { result: null };
      },
    };
    const uiSpec = spec({ editable: true }, [
      {
        on: "root.cellEdit",
        emit: "action.invoke",
        payload: { action: "updateCell", value: "$value.value" },
      },
    ]);
    renderSpreadsheet(uiSpec, binding);
    const editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    const input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.keyDown(input, { key: "Enter" }); // unchanged value ("2")
    await flush();
    expect(invokes).toEqual([]);
    expect(screen.getAllByRole("button", { name: "Edit Revenue" })[0]?.textContent).toBe("2");
  });

  it("action.invoke writes straight through; a subsequent invalidation replaces the optimistic value with the server's", async () => {
    let serverRows = ROWS;
    const binding: BindingClient = {
      async resolve() {
        return tableData(serverRows);
      },
      async invokeAction() {
        serverRows = [
          { region: "japan", revenue: 500 },
          { region: "us", revenue: 1 },
        ];
        return { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "v2" } };
      },
    };
    const uiSpec = spec({ editable: true }, [
      {
        on: "root.cellEdit",
        emit: "action.invoke",
        payload: { action: "updateCell", value: "$value.value" },
      },
    ]);
    renderSpreadsheet(uiSpec, binding);
    const editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    const input = screen.getByRole("textbox", { name: "Edit Revenue" });
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    await flush();
    // Once the invalidated re-fetch returns fresh data, it supersedes the optimistic copy (a brand
    // new rows reference discards the working copy automatically — see commitCellEdit/effectiveRows).
    expect(screen.getAllByRole("button", { name: "Edit Revenue" })[0]?.textContent).toBe("500");
  });

  it("editable + rowClick: a cell click never also fires rowClick, and the row carries no role=button", async () => {
    const events: SurfaceEvent[] = [];
    const uiSpec = spec({ editable: true }, [
      { on: "root.rowClick", emit: "intent.patch", payload: { region: "$row.region" } },
    ]);
    renderSpreadsheet(uiSpec, fakeBinding(ROWS), (e) => events.push(e));
    const editBtn = (await screen.findAllByRole("button", { name: "Edit Revenue" }))[0]!;
    fireEvent.click(editBtn);
    await flush();
    expect(events).toEqual([]);
    const row = document.querySelector('[data-kohaku="root"] tbody tr');
    expect(row?.getAttribute("role")).toBeNull();
    expect(row?.hasAttribute("tabindex")).toBe(false);
  });
});
