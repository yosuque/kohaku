import type { BindingClient } from "@kohaku-ui/data-binding";
import { rowKey } from "@kohaku-ui/renderer-core";
import { parseSpec, type TabularColumn, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { type ImplProps, RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;
const REF = "query://ledger/rows";

function binding(regions: string[]): BindingClient {
  const data: TabularData = {
    columns: [{ key: "region", label: "Region", type: "string" }],
    rows: regions.map((region) => ({ region })),
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

function listSpec(args: {
  listProps?: Record<string, unknown>;
  template: UISpec["components"][number];
  events?: UISpec["events"];
}): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["list1"] },
      {
        id: "list1",
        type: "presentList",
        props: args.listProps ?? {},
        data: { $ref: REF },
        children: [args.template.id],
      },
      args.template,
    ],
    events: args.events ?? [],
    provenance: PROVENANCE,
  });
}

function renderList(regions: string[], spec: UISpec, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), binding: binding(regions), theme: {}, onEvent }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("presentList (row template mechanism)", () => {
  it("renders the children template once per row and replaces $row in props with each row's values", async () => {
    const spec = listSpec({
      template: { id: "tpl", type: "text.heading", props: { level: 3, text: "$row.region" } },
    });
    renderList(["japan", "usa"], spec);
    await waitFor(() => expect(screen.getByText("japan")).toBeDefined());
    expect(screen.getByText("usa")).toBeDefined();
    // role=list + a listitem per row
    expect(screen.getByRole("list")).toBeDefined();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("emit from in-row parts auto-supplies the row context (resolves $row in payload)", async () => {
    const events: SurfaceEvent[] = [];
    const spec = listSpec({
      template: { id: "detail", type: "action.button", props: { label: "$row.region" } },
      events: [{ on: "detail.press", emit: "action.invoke", payload: { region: "$row.region" } }],
    });
    renderList(["japan", "usa"], spec, (e) => events.push(e));
    await waitFor(() => expect(screen.getByRole("button", { name: "usa" })).toBeDefined());

    fireEvent.click(screen.getByRole("button", { name: "usa" }));
    expect(events).toEqual([
      { componentId: "detail", on: "detail.press", emit: "action.invoke", payload: { region: "usa" } },
    ]);
  });

  it("itemClick fires on the row element and $row in payload resolves to that row", async () => {
    const events: SurfaceEvent[] = [];
    const spec = listSpec({
      template: { id: "tpl", type: "text.heading", props: { level: 3, text: "$row.region" } },
      events: [{ on: "list1.itemClick", emit: "intent.patch", payload: { picked: "$row.region" } }],
    });
    renderList(["japan", "usa"], spec, (e) => events.push(e));
    await waitFor(() => expect(screen.getByText("japan")).toBeDefined());

    fireEvent.click(screen.getAllByRole("listitem")[0]!);
    expect(events).toEqual([
      { componentId: "list1", on: "list1.itemClick", emit: "intent.patch", payload: { picked: "japan" } },
    ]);
  });

  it("maxItems caps the number of rows", async () => {
    const spec = listSpec({
      listProps: { maxItems: 2 },
      template: { id: "tpl", type: "text.heading", props: { level: 3, text: "$row.region" } },
    });
    renderList(["a", "b", "c", "d", "e"], spec);
    await waitFor(() => expect(screen.getByText("a")).toBeDefined());
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("c")).toBeNull();
  });

  it("shows emptyText when data is empty", async () => {
    const spec = listSpec({
      listProps: { emptyText: "No items" },
      template: { id: "tpl", type: "text.heading", props: { level: 3, text: "$row.region" } },
    });
    renderList([], spec);
    await waitFor(() => expect(screen.getByText("No items")).toBeDefined());
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("presentList (V4: row key follows row content)", () => {
  const cols: TabularColumn[] = [{ key: "region", label: "Region", type: "string" }];

  // A pure index key (key={i}) is determined by index alone, so on insertion/reordering, index0's DOM/local state
  // sticks to "the different row that flowed into that position." rowKey weaves in the row content, so even at the same index, different content yields a different key.
  it("even at the same index, different row content yields a different key (the key that keeps state from sticking to another row)", () => {
    expect(rowKey({ region: "a" }, cols, 0)).not.toBe(rowKey({ region: "z" }, cols, 0));
  });

  it("same content and same index returns a stable key", () => {
    expect(rowKey({ region: "a" }, cols, 0)).toBe(rowKey({ region: "a" }, cols, 0));
  });

  it("name collisions (multiple rows with identical content) are distinguished by the trailing index", () => {
    expect(rowKey({ region: "a" }, cols, 0)).not.toBe(rowKey({ region: "a" }, cols, 1));
  });

  // A template component holding local state (count). The state appears only in the DOM (the button text).
  // With a pure index key, reordering rows sticks this state to a different row (index0's state flows to the new row at that position).
  function StatefulProbe({ node }: ImplProps): ReactNode {
    const [count, setCount] = useState(0);
    const label = String(node.props["label"] ?? "");
    return (
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        {`${label}:${count}`}
      </button>
    );
  }

  it("reordering rows keeps local state from sticking to another row (content key)", async () => {
    // Hold the data object and later swap rows in-place to reorder "while staying ready"
    // (since binding/ref are unchanged, useBoundData does not re-resolve and no loading flash occurs).
    const data: TabularData = {
      columns: [{ key: "region", label: "Region", type: "string" }],
      rows: [{ region: "a" }, { region: "b" }],
      dataVersion: "v1",
    };
    const stableBinding: BindingClient = {
      async resolve() {
        return data;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const impls = createCoreRegistry().register("test.probe", "1.0.0", StatefulProbe);
    const spec = listSpec({
      template: { id: "probe", type: "test.probe", props: { label: "$row.region" } },
    });

    const { rerender } = render(
      <RendererProvider value={{ impls, binding: stableBinding, theme: {} }}>
        <SpecView spec={spec} />
      </RendererProvider>,
    );
    await waitFor(() => expect(screen.getByText("a:0")).toBeDefined());

    // Advance row a's local state (a:0 → a:1).
    fireEvent.click(screen.getByText("a:0"));
    expect(screen.getByText("a:1")).toBeDefined();

    // Reorder rows to [b, a] (in-place on the same data object). No re-resolution occurs.
    data.rows = [{ region: "b" }, { region: "a" }];
    rerender(
      <RendererProvider value={{ impls, binding: stableBinding, theme: {} }}>
        <SpecView spec={spec} />
      </RendererProvider>,
    );

    // With a pure index key, index0's state (=1) would stick to the new index0 row b, becoming "b:1".
    // With a content key it does not stick (b keeps its own state = b:0).
    await waitFor(() => expect(screen.getByText("b:0")).toBeDefined());
    expect(screen.queryByText("b:1")).toBeNull();
  });
});
