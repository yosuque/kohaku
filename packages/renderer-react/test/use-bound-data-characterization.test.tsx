import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import {
  createDataInvalidationBus,
  DataInvalidationContext,
  type ImplProps,
  RendererProvider,
  SpecView,
  useBoundData,
} from "../src/index.js";

/**
 * Characterization tests for the migration of useBoundData to a thin wrapper over
 * renderer-core's BoundDataController (design: sonnet5-mossy-sunset-agent-aplan-bound-data).
 * These MUST pass on the current effect-based implementation before and after the
 * migration — they pin the exact resolve call sequence, the re-attach granularity,
 * and the no-double-resolve / last-wins guarantees that the design depends on.
 */

// Flush pending microtasks (binding.resolve's .then chain) without expecting any
// React state change, to positively assert that nothing re-resolved.
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// A. A1 switching race (core bound-data-controller.test.ts's React counterpart):
//    exactly 2 resolves on switch, no double resolve after flushing, the old
//    resolve does not overwrite the new display, no false STALE, and the bus
//    subscription follows the effective ref (re-resolves the new ref, ignores the old).
// ---------------------------------------------------------------------------

const REF_JAPAN = "query://sales/kpi?region=japan";
const REF_EUROPE = "query://sales/kpi?region=europe";

function crossFilterMetricSpec(): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: { canonical: "sales.kpi", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "multi:deadbeefdeadbeef",
    refVersions: { [REF_JAPAN]: "src@v1" },
    state: { region: "japan" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["filter", "kpi"] },
      {
        id: "filter",
        type: "control.select",
        props: {
          label: "Region",
          value: "japan",
          options: [
            { value: "japan", label: "Japan" },
            { value: "europe", label: "Europe" },
          ],
        },
      },
      {
        id: "kpi",
        type: "presentMetric",
        props: { label: "Revenue", valueColumn: "revenue" },
        data: {
          $ref: REF_JAPAN,
          bind: { region: { $state: "region", values: ["japan", "europe"] } },
        },
      },
    ],
    events: [{ on: "filter.change", emit: "state.set", payload: { key: "region", value: "$value" } }],
    provenance: { tier: "L0", composedBy: "template", cache: "fixated" },
  });
}

interface PendingResolve {
  ref: string;
  opts?: ResolveOptions;
  resolve: (data: TabularData) => void;
}

function manualBinding(): { binding: BindingClient; pending: PendingResolve[] } {
  const pending: PendingResolve[] = [];
  const binding: BindingClient = {
    resolve(refInput, opts?: ResolveOptions) {
      const ref = typeof refInput === "string" ? refInput : refInput.$ref;
      return new Promise<TabularData>((resolve) => {
        pending.push({ ref, opts, resolve });
      });
    },
    async invokeAction() {
      return { result: null };
    },
  };
  return { binding, pending };
}

function metricEl(): HTMLElement {
  return document.querySelector('[data-kohaku="kpi"]') as HTMLElement;
}

describe("useBoundData characterization A: A1 switching race + bus follows the effective ref", () => {
  it("switches with exactly 2 resolves, no double resolve, last-wins display, no false STALE, bus re-subscribes to the new ref", async () => {
    const { binding, pending } = manualBinding();
    const bus = createDataInvalidationBus();
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        <DataInvalidationContext.Provider value={bus}>
          <SpecView spec={crossFilterMetricSpec()} />
        </DataInvalidationContext.Provider>
      </RendererProvider>,
    );

    // 1. Initial render issues exactly one resolve for the raw $ref, matched against refVersions.
    await waitFor(() => expect(pending.length).toBe(1));
    expect(pending[0]!.ref).toBe(REF_JAPAN);
    expect(pending[0]!.opts?.expectedDataVersion).toBe("src@v1");

    // 2. Switching the filter to europe issues exactly one more resolve (the $state-derived variant, no cross-check).
    const select = screen.getByRole("combobox", { name: "Region" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "europe" } });
    await waitFor(() => expect(pending.length).toBe(2));
    expect(pending[1]!.ref).toBe(REF_EUROPE);
    expect(pending[1]!.opts?.expectedDataVersion).toBeUndefined();

    // 3. Flushing microtasks must NOT trigger a further resolve (no double resolve on the switch).
    await flush();
    expect(pending.length).toBe(2);

    // 4. Settling the new (later-issued) resolve shows its value.
    await act(async () => {
      pending[1]!.resolve({
        columns: [{ key: "revenue", label: "Revenue", type: "number" }],
        rows: [{ revenue: 200 }],
        dataVersion: "eu@v1",
      });
    });
    await waitFor(() => expect(metricEl().textContent).toMatch(/200/));

    // 5. Settling the stale (earlier-issued, old-ref) resolve afterward must not overwrite the display, nor show STALE.
    await act(async () => {
      pending[0]!.resolve({
        columns: [{ key: "revenue", label: "Revenue", type: "number" }],
        rows: [{ revenue: 100 }],
        dataVersion: "src@v1",
      });
    });
    await flush();
    expect(metricEl().textContent).toMatch(/200/);
    expect(metricEl().textContent).not.toMatch(/100/);
    expect(screen.queryByText(/Data has been updated/)).toBeNull();

    // 6. A bus publish for the NEW (europe) ref re-resolves, cross-checked against the event's refVersions.
    act(() => bus.publish({ refs: [REF_EUROPE], refVersions: { [REF_EUROPE]: "v9" } }));
    await waitFor(() => expect(pending.length).toBe(3));
    expect(pending[2]!.ref).toBe(REF_EUROPE);
    expect(pending[2]!.opts?.expectedDataVersion).toBe("v9");

    // 7. A bus publish for the OLD (japan) ref does nothing — its subscription was torn down on switch.
    act(() => bus.publish({ refs: [REF_JAPAN] }));
    await flush();
    expect(pending.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// B. Spec re-delivery granularity: re-resolution must track only the
//    Spec-derived "expected" version (by value), not Spec / node object identity.
// ---------------------------------------------------------------------------

const REF = "query://sales/kpi?region=fixed";
const OTHER_REF = "query://sales/kpi?region=other";

const METRIC_DATA: TabularData = {
  columns: [{ key: "revenue", label: "Revenue", type: "number" }],
  rows: [{ revenue: 1 }],
  dataVersion: "v1",
};

function capturingBinding(): { binding: BindingClient; calls: { ref: string; expected?: string }[] } {
  const calls: { ref: string; expected?: string }[] = [];
  const binding: BindingClient = {
    async resolve(refInput, opts?: ResolveOptions) {
      const ref = typeof refInput === "string" ? refInput : refInput.$ref;
      calls.push({ ref, expected: opts?.expectedDataVersion });
      return METRIC_DATA;
    },
    async invokeAction() {
      return { result: null };
    },
  };
  return { binding, calls };
}

function fixedRefMetricSpec(refVersion: string, otherRefVersion: string): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: { canonical: "sales.kpi_fixed", params: {}, hash: "sha256:" + "1".repeat(64) },
    dataVersion: "multi:deadbeefdeadbeef",
    refVersions: { [REF]: refVersion, [OTHER_REF]: otherRefVersion },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["kpi"] },
      {
        id: "kpi",
        type: "presentMetric",
        props: { label: "Revenue", valueColumn: "revenue" },
        data: { $ref: REF },
      },
    ],
    events: [],
    provenance: { tier: "L1", composedBy: "test", cache: "hit" },
  });
}

describe("useBoundData characterization B: Spec re-delivery granularity", () => {
  it("re-resolves only when the OWN ref's refVersions entry changes by value, not on same-content or unrelated-ref Spec re-delivery", async () => {
    const { binding, calls } = capturingBinding();
    const { rerender } = render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        <SpecView spec={fixedRefMetricSpec("src@v1", "same")} />
      </RendererProvider>,
    );

    // 1. Initial resolve.
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.expected).toBe("src@v1");

    // 2. Re-delivering a Spec with IDENTICAL content (a new object) must not re-resolve.
    rerender(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        <SpecView spec={fixedRefMetricSpec("src@v1", "same")} />
      </RendererProvider>,
    );
    await flush();
    expect(calls.length).toBe(1);

    // 3. Changing the OWN ref's refVersions entry must re-resolve, matched against the new value.
    rerender(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        <SpecView spec={fixedRefMetricSpec("src@v2", "same")} />
      </RendererProvider>,
    );
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]!.expected).toBe("src@v2");

    // 4. Changing only ANOTHER ref's refVersions entry must not re-resolve.
    rerender(
      <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
        <SpecView spec={fixedRefMetricSpec("src@v2", "different")} />
      </RendererProvider>,
    );
    await flush();
    expect(calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// C. A useBoundData call inside a presentList row template must not re-attach
//    (re-resolve / loading-flash) on an unrelated $state change. Guards against
//    a wrong deps design that keys re-attach off node/props object identity
//    (resolveRowProps returns a new node object on every render).
// ---------------------------------------------------------------------------

const REF_LIST = "query://list/rows";
const REF_ROW = "query://row/detail";

function RowProbe({ node }: ImplProps): ReactNode {
  const state = useBoundData(node);
  return <div data-testid="row-probe">{state.status}</div>;
}

function rowTemplateSpec(): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: { canonical: "list.probe", params: {}, hash: "sha256:" + "2".repeat(64) },
    dataVersion: "v1",
    state: { other: "a" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["filter", "list1"] },
      {
        id: "filter",
        type: "control.select",
        props: {
          label: "Other",
          value: "a",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
      },
      {
        id: "list1",
        type: "presentList",
        props: {},
        data: { $ref: REF_LIST },
        children: ["probe"],
      },
      { id: "probe", type: "test.rowProbe", props: {}, data: { $ref: REF_ROW } },
    ],
    events: [{ on: "filter.change", emit: "state.set", payload: { key: "other", value: "$value" } }],
    provenance: { tier: "L0", composedBy: "test", cache: "hit" },
  });
}

describe("useBoundData characterization C: row template does not re-attach on unrelated $state change", () => {
  it("an unrelated $state.set (via a sibling control.select) does not re-resolve the row template's own bound ref", async () => {
    const listData: TabularData = {
      columns: [{ key: "id", label: "Id", type: "string" }],
      rows: [{ id: "r1" }, { id: "r2" }],
      dataVersion: "list@v1",
    };
    const rowResolvers: ((d: TabularData) => void)[] = [];
    const binding: BindingClient = {
      resolve(refInput) {
        const ref = typeof refInput === "string" ? refInput : refInput.$ref;
        if (ref === REF_LIST) return Promise.resolve(listData);
        return new Promise<TabularData>((resolve) => rowResolvers.push(resolve));
      },
      async invokeAction() {
        return { result: null };
      },
    };
    const impls = createCoreRegistry().register("test.rowProbe", "1.0.0", RowProbe);

    render(
      <RendererProvider value={{ impls, binding, theme: {} }}>
        <SpecView spec={rowTemplateSpec()} />
      </RendererProvider>,
    );

    // One row-probe attach per list row (2 rows → 2 pending row resolves).
    await waitFor(() => expect(rowResolvers.length).toBe(2));
    await act(async () => {
      rowResolvers[0]!({
        columns: [{ key: "v", label: "V", type: "string" }],
        rows: [{ v: "x" }],
        dataVersion: "row@v1",
      });
      rowResolvers[1]!({
        columns: [{ key: "v", label: "V", type: "string" }],
        rows: [{ v: "x" }],
        dataVersion: "row@v1",
      });
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("row-probe").every((el) => el.textContent === "ready")).toBe(true),
    );

    // Trigger an unrelated $state.set (does not touch either row's ref/bind).
    const select = screen.getByRole("combobox", { name: "Other" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "b" } });

    // No re-attach: no new row resolve is issued, and no row flashes back to loading.
    await flush();
    expect(rowResolvers.length).toBe(2);
    for (const el of screen.getAllByTestId("row-probe")) {
      expect(el.textContent).toBe("ready");
    }
  });
});
