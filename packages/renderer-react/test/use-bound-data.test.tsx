import { type BindingClient, BindingError, type ResolveOptions } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import {
  createDataInvalidationBus,
  DataInvalidationContext,
  RendererProvider,
  SpecView,
} from "../src/index.js";

const REF = "query://ledger/sales_summary?fy=2026&groupBy=region&q=3";

const DATA: TabularData = {
  columns: [
    { key: "region", label: "Region", type: "string" },
    { key: "revenue", label: "Revenue", type: "number" },
  ],
  rows: [{ region: "japan", revenue: 498200000 }],
  dataVersion: "src@v1",
};

/** A Spec equivalent to multiple $refs whose dataVersion is synthesized as multi: (holding per-reference versions in refVersions) */
function multiRefSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "multi:deadbeefdeadbeef",
    refVersions: { [REF]: "src@v1" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["table1"] },
      {
        id: "table1",
        type: "presentSpreadsheet",
        props: { editable: false },
        data: { $ref: REF },
      },
    ],
    events: [],
    provenance: { tier: "L1", composedBy: "test", cache: "hit" },
  });
}

describe("useBoundData (per-reference version cross-check via refVersions)", () => {
  it("even when dataVersion is multi:, cross-check uses the per-reference version and does not become STALE", async () => {
    const captured: (string | undefined)[] = [];
    const binding: BindingClient = {
      async resolve(_ref, opts?: ResolveOptions) {
        captured.push(opts?.expectedDataVersion);
        return DATA;
      },
      async invokeAction() {
        return { result: null };
      },
    };
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        <SpecView spec={multiRefSpec()} />
      </RendererProvider>,
    );

    // The expectedDataVersion passed to binding is the per-reference version, not multi:
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    expect(captured.every((v) => v === "src@v1")).toBe(true);

    // Data renders = no STALE display
    const table = () => within(document.querySelector('[data-kohaku="table1"]') as HTMLElement);
    await waitFor(() => expect(table().getByText("japan")).toBeDefined());
    expect(screen.queryByText(/Data has been updated/)).toBeNull();
  });
});

describe("useBoundData (V3: race between the main path and bus re-resolution)", () => {
  it("a slow earlier-issued (main path) response does not overwrite the later-issued (bus re-resolution) result (last-issued wins)", async () => {
    // A binding whose resolution can be settled manually. It stores resolvers in the order resolve is called.
    const resolvers: ((d: TabularData) => void)[] = [];
    const binding: BindingClient = {
      resolve(_ref, _opts?: ResolveOptions) {
        return new Promise<TabularData>((res) => resolvers.push(res));
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const bus = createDataInvalidationBus();
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        {/* Insert our own bus inside so the test can publish. */}
        <DataInvalidationContext.Provider value={bus}>
          <SpecView spec={multiRefSpec()} />
        </DataInvalidationContext.Provider>
      </RendererProvider>,
    );

    const table = () => within(document.querySelector('[data-kohaku="table1"]') as HTMLElement);

    // The main-path resolution (first-issued = seq 1) is issued and pending.
    await waitFor(() => expect(resolvers.length).toBe(1));

    // Publish invalidation → the bus re-resolution (later-issued = seq 2) is issued and pending.
    act(() => bus.publish({ refs: [REF] }));
    await waitFor(() => expect(resolvers.length).toBe(2));

    // Settle the later-issued (seq 2) first → this should be displayed.
    await act(async () => {
      resolvers[1]!({
        columns: DATA.columns,
        rows: [{ region: "fresh", revenue: 2 }],
        dataVersion: "v2",
      });
    });
    await waitFor(() => expect(table().getByText("fresh")).toBeDefined());

    // Settle the first-issued (seq 1) later → it is stale, so it does not overwrite the display.
    await act(async () => {
      resolvers[0]!({
        columns: DATA.columns,
        rows: [{ region: "stale", revenue: 1 }],
        dataVersion: "v1",
      });
    });

    // The later-issued result (fresh) is still displayed, not overwritten by the first-issued stale.
    expect(table().getByText("fresh")).toBeDefined();
    expect(table().queryByText("stale")).toBeNull();
  });
});

describe("useBoundData (surfacing STALE_VERSION)", () => {
  it("when binding.resolve throws STALE_VERSION, it renders a role=status stale badge and the dataStale message", async () => {
    const binding: BindingClient = {
      async resolve() {
        // The error the binding throws when the data side advanced first (equivalent to 409)
        throw new BindingError("STALE_VERSION", "Data version is newer than Spec", { status: 409 });
      },
      async invokeAction() {
        return { result: null };
      },
    };
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        <SpecView spec={multiRefSpec()} />
      </RendererProvider>,
    );

    // stale surfaces via the dataStale message (distinguish it from loading's role=status by message before waiting)
    await waitFor(() => expect(screen.getByText(/Data has been updated/)).toBeDefined());
    // Presented as a non-interrupting notice (role="status") (contrasted with error's role="alert")
    const notice = screen.getByRole("status");
    expect(notice.textContent).toMatch(/Data has been updated/);
  });
});
