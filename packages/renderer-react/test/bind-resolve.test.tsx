import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView } from "../src/index.js";

const REF_JAPAN = "query://sales/summary?fy=2026&region=japan";
const REF_EUROPE = "query://sales/summary?fy=2026&region=europe";

const DATA: TabularData = {
  columns: [{ key: "revenue", label: "Revenue", type: "number" }],
  rows: [{ revenue: 100 }],
  dataVersion: "src@v1",
};

/** A cross-filter Spec of control.select (region filter) + presentMetric (region binding). */
function crossFilterSpec(): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: { canonical: "sales.quarterly_summary", params: {}, hash: "sha256:" + "0".repeat(64) },
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

/** A mock that captures binding.resolve's (ref, expectedDataVersion). */
function capturingBinding(): { binding: BindingClient; calls: { ref: string; expected?: string }[] } {
  const calls: { ref: string; expected?: string }[] = [];
  const binding: BindingClient = {
    async resolve(refInput, opts?: ResolveOptions) {
      const ref = typeof refInput === "string" ? refInput : refInput.$ref;
      calls.push({ ref, expected: opts?.expectedDataVersion });
      return DATA;
    },
    async invokeAction() {
      return { result: null };
    },
  };
  return { binding, calls };
}

function renderSpec(binding: BindingClient) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
      <SpecView spec={crossFilterSpec()} />
    </RendererProvider>,
  );
}

describe("two-way binding: effective ref resolution and freshness cross-check", () => {
  it("the initial variant resolves with the raw $ref and cross-checks with refVersions' per-reference version", async () => {
    const { binding, calls } = capturingBinding();
    renderSpec(binding);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // The initial resolve uses the $ref itself (the initial variant), and the cross-check target is refVersions[$ref] = src@v1.
    expect(calls[0]!.ref).toBe(REF_JAPAN);
    expect(calls[0]!.expected).toBe("src@v1");
    // No false STALE appears
    expect(screen.queryByText(/Data has been updated/)).toBeNull();
  });

  it("a $state change switches the effective ref, and a client-derived variant skips the cross-check (no false STALE)", async () => {
    const { binding, calls } = capturingBinding();
    renderSpec(binding);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    // Change the region filter to europe → state.set sets $state.region = "europe" → kpi re-resolves.
    const select = screen.getByRole("combobox", { name: "Region" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "europe" } });

    // Re-resolved with the europe variant
    const europeCall = await waitFor(() => {
      const c = calls.find((x) => x.ref === REF_EUROPE);
      expect(c).toBeDefined();
      return c!;
    });
    // A client-derived alternate variant is not in refVersions and does no dataVersion cross-check (expected=undefined).
    expect(europeCall.expected).toBeUndefined();
    // No false STALE appears (since the cross-check is skipped, a version mismatch does not warn)
    expect(screen.queryByText(/Data has been updated/)).toBeNull();
  });

  it("control.select's displayed value follows $state (controlled component)", async () => {
    const { binding, calls } = capturingBinding();
    renderSpec(binding);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    const select = screen.getByRole("combobox", { name: "Region" }) as HTMLSelectElement;
    expect(select.value).toBe("japan");

    fireEvent.change(select, { target: { value: "europe" } });
    // state.set → $state.region updated → the display value also follows to europe
    await waitFor(() => expect(select.value).toBe("europe"));
  });
});
