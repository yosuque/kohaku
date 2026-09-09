// Proves that, when pointClick is declared, both renderers (React=Recharts / WC=hand-drawn SVG) forward
// **a SurfaceEvent with the same payload** on the same data-point click.
// The existing policy of keeping chart visual representation at semantic equivalence is unchanged (this file only matches the externally observed payload).
//
// Since Recharts' ResponsiveContainer renders the child chart at 0x0 in jsdom, replace it with a mock that injects
// fixed dimensions so the inner chart draws real SVG (clickable bars).

import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent } from "@testing-library/react";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("recharts", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: 600,
            height: 320,
          })
        : children,
  };
});

import { cleanupPair, renderReact, renderWc, type SurfaceEvent } from "./render-both.js";

const INTENT = { canonical: "parity.pointclick", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "parity", cache: "hit" } as const;
const REF = "query://sales/summary";

const ROWS: TabularData["rows"] = [
  { region: "japan", revenue: 498200000 },
  { region: "north_america", revenue: 612800000 },
];

function binding() {
  return {
    async resolve() {
      return {
        columns: [
          { key: "region", label: "Region", type: "string" as const },
          { key: "revenue", label: "Revenue", type: "number" as const },
        ],
        rows: ROWS,
        dataVersion: "v1",
      };
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
    refVersions: { [REF]: "v1" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["chart1"] },
      {
        id: "chart1",
        type: "presentChart",
        props: { kind: "bar", x: "region", y: "revenue" },
        data: { $ref: REF },
      },
    ],
    events: [
      {
        on: "chart1.pointClick",
        emit: "intent.patch",
        payload: { region: "$row.region", revenue: "$row.revenue" },
      },
    ],
    provenance: PROVENANCE,
  });
}

describe("chart pointClick parity (both renderers forward the same payload)", () => {
  afterEach(() => cleanupPair());

  it("clicking the first bar delivers the same SurfaceEvent from both renderers", async () => {
    const spec = chartSpec();
    const ctx = { binding };

    const reactEvents: SurfaceEvent[] = [];
    const { container } = await renderReact(spec, ctx, (e) => reactEvents.push(e));
    const reactBar = container.querySelectorAll(".recharts-bar-rectangle")[0];
    expect(reactBar).toBeTruthy();
    fireEvent.click(reactBar!);

    const wcEvents: SurfaceEvent[] = [];
    const { surface } = await renderWc(spec, ctx, (e) => wcEvents.push(e));
    const wcRect = surface.shadowRoot!.querySelector('[data-kohaku="chart1"] svg rect');
    expect(wcRect).toBeTruthy();
    wcRect!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const expected = [
      {
        componentId: "chart1",
        on: "chart1.pointClick",
        emit: "intent.patch",
        payload: { region: "japan", revenue: 498200000 },
      },
    ];
    expect(reactEvents).toEqual(expected);
    expect(wcEvents).toEqual(reactEvents);
  });
});
