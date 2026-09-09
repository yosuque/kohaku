import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

/** A Spec with view=chart|table tabs + an out-of-tab heading linked via visibleWhen. */
function tabsSpec(initial = "chart"): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    state: { view: initial },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["tabs1", "extra"] },
      { id: "tabs1", type: "layout.tabs", props: { stateKey: "view" }, children: ["tabChart", "tabTable"] },
      { id: "tabChart", type: "layout.tab", props: { value: "chart", label: "Chart" }, children: ["hChart"] },
      { id: "tabTable", type: "layout.tab", props: { value: "table", label: "Table" }, children: ["hTable"] },
      { id: "hChart", type: "text.heading", props: { level: 3, text: "Chart panel" } },
      { id: "hTable", type: "text.heading", props: { level: 3, text: "Table panel" } },
      {
        id: "extra",
        type: "text.heading",
        props: { level: 4, text: "Detail view" },
        visibleWhen: { ref: "$state.view", eq: "table" },
      },
    ],
    events: [{ on: "tabs1.select", emit: "intent.patch", payload: { view: "$value" } }],
    provenance: PROVENANCE,
  });
}

function renderTabs(spec: UISpec, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), theme: {}, onEvent }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("layout.tabs / layout.tab", () => {
  it("renders only the initially selected tab's panel (unselected are unmounted)", () => {
    renderTabs(tabsSpec("chart"));
    expect(screen.getByText("Chart panel")).toBeDefined();
    expect(screen.queryByText("Table panel")).toBeNull();
    // tablist + tab accessibility
    expect(screen.getByRole("tablist")).toBeDefined();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("false");
  });

  it("switching tabs changes state so the panel and out-of-tab visibleWhen move in tandem", () => {
    const events: SurfaceEvent[] = [];
    renderTabs(tabsSpec("chart"), (e) => events.push(e));
    // Initially the out-of-tab detail heading is hidden
    expect(screen.queryByText("Detail view")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Table" }));

    // The panel switches (chart panel unmount / table panel mount)
    expect(screen.queryByText("Chart panel")).toBeNull();
    expect(screen.getByText("Table panel")).toBeDefined();
    // The out-of-tab visibleWhen ($state.view === "table") also shows in tandem
    expect(screen.getByText("Detail view")).toBeDefined();
    // "select" is declared, so it reaches upstream with $value resolved
    expect(events).toEqual([
      { componentId: "tabs1", on: "tabs1.select", emit: "intent.patch", payload: { view: "table" } },
    ]);
  });

  it("arrow keys move to and select the adjacent tab", () => {
    renderTabs(tabsSpec("chart"));
    const tabs = screen.getAllByRole("tab");
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(screen.getByText("Table panel")).toBeDefined();
    expect(screen.getAllByRole("tab")[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it('even without a declared "select", tab switching works via state (guards against missed declarations)', () => {
    const spec = parseSpec({
      ...tabsSpec("chart"),
      events: [],
    });
    const onEvent = vi.fn();
    renderTabs(spec, onEvent);
    fireEvent.click(screen.getByRole("tab", { name: "Table" }));
    expect(screen.getByText("Table panel")).toBeDefined();
    // Without a declaration, it does not reach onEvent (governance)
    expect(onEvent).not.toHaveBeenCalled();
  });
});
