import type { BindingClient } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { createCoreRegistry } from "../src/core/index.js";
import { type ImplProps, RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const DATA: TabularData = {
  columns: [
    { key: "region", label: "Region", type: "string" },
    { key: "revenue", label: "Revenue", type: "number" },
  ],
  rows: [
    { region: "japan", revenue: 498200000 },
    { region: "north_america", revenue: 612800000 },
  ],
  dataVersion: "ledger@2026-06-10T03:12:00Z",
};

function fakeBinding(): BindingClient {
  return {
    async resolve() {
      return DATA;
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

function renderFixture(onEvent?: (e: SurfaceEvent) => void) {
  const spec = parseSpec(fixture);
  return render(
    <RendererProvider
      value={{
        impls: createCoreRegistry(),
        binding: fakeBinding(),
        theme: {},
        onEvent,
      }}
    >
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("SpecView (DOM rendering of the canonical fixture)", () => {
  const table = () => within(document.querySelector('[data-kohaku="table1"]') as HTMLElement);

  it("heading, table, and data rows are rendered", async () => {
    renderFixture();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("FY2026 Q3 Sales (by Region)");
    await waitFor(() => {
      expect(table().getByText("japan")).toBeDefined();
    });
    // Numbers are locale-formatted
    expect(table().getByText("498,200,000")).toBeDefined();
    // The chart container also exists
    expect(document.querySelector('[data-kohaku="chart1"]')).not.toBeNull();
  });

  it("rowClick fires as a Spec-declared event with the $row placeholder resolved", async () => {
    const events: SurfaceEvent[] = [];
    renderFixture((e) => events.push(e));
    await waitFor(() => expect(table().getByText("japan")).toBeDefined());

    fireEvent.click(table().getByText("japan"));
    expect(events).toEqual([
      {
        componentId: "table1",
        on: "table1.rowClick",
        emit: "intent.patch",
        payload: { drilldown: "japan" },
      },
    ]);
  });

  it("an unimplemented type shows a placeholder (rendering does not break)", () => {
    const spec = parseSpec({
      ...fixture,
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["x"] },
        { id: "x", type: "custom.widget", props: {} },
      ],
      events: [],
    });
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), theme: {} }}>
        <SpecView spec={spec} />
      </RendererProvider>,
    );
    expect(screen.getByRole("note").textContent).toContain("custom.widget");
  });
});

// enableViewTransitions characterization (React 19.3's <ViewTransition>). See SpecView.tsx's
// SpecViewProps.enableViewTransitions doc comment for the full reasoning behind the tier+intent key.
// A mount-counting "test.probe" impl stands in for "was the DOM subtree remounted": SpecView's
// <ViewTransition> only forces a remount by changing its `key` across a rerender, so counting mounts
// is a more faithful pin than inspecting markup (<ViewTransition> itself renders no host DOM node).
const INTENT_A = {
  canonical: "sales.quarterly_summary",
  params: {},
  hash: "sha256:" + "0".repeat(64),
} as const;
const INTENT_B = { canonical: "sales.by_product", params: {}, hash: "sha256:" + "1".repeat(64) } as const;

function probeSpec(opts: {
  tier: "L0" | "L1";
  intent: typeof INTENT_A | typeof INTENT_B;
  label: string;
}): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: opts.intent,
    dataVersion: "v1",
    components: [{ id: "root", type: "test.probe", props: { label: opts.label } }],
    events: [],
    provenance: { tier: opts.tier, composedBy: "test", cache: "hit" },
  });
}

function renderProbe(spec: UISpec, enableViewTransitions: boolean | undefined, onMount: () => void) {
  function Probe({ node }: ImplProps): ReactNode {
    useEffect(onMount, []); // fires once per mount, not on every prop update
    return <div data-kohaku={node.id}>{String(node.props["label"])}</div>;
  }
  const impls = createCoreRegistry().register("test.probe", "1.0.0", Probe);
  return render(
    <RendererProvider value={{ impls, theme: {} }}>
      <SpecView spec={spec} enableViewTransitions={enableViewTransitions} />
    </RendererProvider>,
  );
}

describe("SpecView enableViewTransitions", () => {
  it("defaults to off: a tier swap (L0 → L1) reconciles in place, no remount", () => {
    let mounts = 0;
    function Probe({ node }: ImplProps): ReactNode {
      useEffect(() => void mounts++, []);
      return <div data-kohaku={node.id}>{String(node.props["label"])}</div>;
    }
    const impls = createCoreRegistry().register("test.probe", "1.0.0", Probe);
    const { rerender } = render(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView spec={probeSpec({ tier: "L0", intent: INTENT_A, label: "before" })} />
      </RendererProvider>,
    );
    expect(mounts).toBe(1);
    expect(screen.getByText("before")).toBeDefined();

    rerender(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView spec={probeSpec({ tier: "L1", intent: INTENT_A, label: "after" })} />
      </RendererProvider>,
    );
    // Content updated but the probe's own effect did not re-fire: React reconciled the existing
    // element in place rather than unmounting/remounting it. Confirms no <ViewTransition> — and
    // hence no forced remount — is present when the prop is omitted.
    expect(mounts).toBe(1);
    expect(screen.getByText("after")).toBeDefined();
  });

  it("on: a tier swap (L0 → L1, a real swap) remounts the subtree", () => {
    let mounts = 0;
    function Probe({ node }: ImplProps): ReactNode {
      useEffect(() => void mounts++, []);
      return <div data-kohaku={node.id}>{String(node.props["label"])}</div>;
    }
    const impls = createCoreRegistry().register("test.probe", "1.0.0", Probe);
    const { rerender } = render(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView spec={probeSpec({ tier: "L0", intent: INTENT_A, label: "before" })} enableViewTransitions />
      </RendererProvider>,
    );
    expect(mounts).toBe(1);

    rerender(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView spec={probeSpec({ tier: "L1", intent: INTENT_A, label: "after" })} enableViewTransitions />
      </RendererProvider>,
    );
    // The transition key (tier:intent) changed → <ViewTransition> remounted its child.
    expect(mounts).toBe(2);
    expect(screen.getByText("after")).toBeDefined();
  });

  it("on: a drill-down (different intent, same tier) also remounts the subtree", () => {
    let mounts = 0;
    function Probe({ node }: ImplProps): ReactNode {
      useEffect(() => void mounts++, []);
      return <div data-kohaku={node.id}>{String(node.props["label"])}</div>;
    }
    const impls = createCoreRegistry().register("test.probe", "1.0.0", Probe);
    const { rerender } = render(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView
          spec={probeSpec({ tier: "L1", intent: INTENT_A, label: "overview" })}
          enableViewTransitions
        />
      </RendererProvider>,
    );
    expect(mounts).toBe(1);

    rerender(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView
          spec={probeSpec({ tier: "L1", intent: INTENT_B, label: "drilldown" })}
          enableViewTransitions
        />
      </RendererProvider>,
    );
    expect(mounts).toBe(2);
    expect(screen.getByText("drilldown")).toBeDefined();
  });

  it("on: a same-generation patch (same tier + intent, content changes) does not remount", () => {
    let mounts = 0;
    function Probe({ node }: ImplProps): ReactNode {
      useEffect(() => void mounts++, []);
      return <div data-kohaku={node.id}>{String(node.props["label"])}</div>;
    }
    const impls = createCoreRegistry().register("test.probe", "1.0.0", Probe);
    const { rerender } = render(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView
          spec={probeSpec({ tier: "L1", intent: INTENT_A, label: "skeleton" })}
          enableViewTransitions
        />
      </RendererProvider>,
    );
    expect(mounts).toBe(1);

    // Simulates a provisional-patch (or final-patch) update within the same stream: tier and intent are
    // unchanged (compose-stream.ts keeps both fixed for a whole generation), only the content differs.
    rerender(
      <RendererProvider value={{ impls, theme: {} }}>
        <SpecView
          spec={probeSpec({ tier: "L1", intent: INTENT_A, label: "settled" })}
          enableViewTransitions
        />
      </RendererProvider>,
    );
    expect(mounts).toBe(1);
    expect(screen.getByText("settled")).toBeDefined();
  });

  it("on: renders without error under jsdom, which has no View Transition API", () => {
    expect(
      typeof (globalThis as { document?: { startViewTransition?: unknown } }).document?.startViewTransition,
    ).toBe("undefined");
    expect(() =>
      renderProbe(probeSpec({ tier: "L1", intent: INTENT_A, label: "ok" }), true, () => undefined),
    ).not.toThrow();
    expect(screen.getByText("ok")).toBeDefined();
  });
});
