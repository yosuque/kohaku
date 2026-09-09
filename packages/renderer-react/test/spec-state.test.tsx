import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type ComponentImpl,
  ImplRegistry,
  RendererProvider,
  SpecView,
  type SurfaceEvent,
  useEmitEvent,
} from "../src/index.js";

const INTENT_A = { canonical: "x.a", params: {}, hash: "sha256:" + "a".repeat(64) } as const;
const INTENT_B = { canonical: "x.b", params: {}, hash: "sha256:" + "b".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;

/** A simple button that fires state.set / intent.patch. The emit name is switched via props.event. */
const Button: ComponentImpl = ({ node }) => {
  const emit = useEmitEvent(node);
  return (
    <button
      type="button"
      data-testid={node.id}
      onClick={() => emit(String(node.props["event"] ?? "press"), {})}
    >
      {String(node.props["label"] ?? node.id)}
    </button>
  );
};
const Panel: ComponentImpl = ({ node }) => (
  <div data-testid={node.id}>{String(node.props["text"] ?? "")}</div>
);
const Stack: ComponentImpl = ({ children }) => <div>{children}</div>;

function impls(): ImplRegistry {
  return new ImplRegistry()
    .register("layout.stack", "1.0.0", Stack)
    .register("test.button", "1.0.0", Button)
    .register("test.panel", "1.0.0", Panel);
}

/** A Spec that switches tab-equivalent state via state.set (intent is swappable). */
function tabSpec(intent: typeof INTENT_A | typeof INTENT_B, initialTab = "a"): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent,
    dataVersion: "v1",
    state: { tab: initialTab },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["toB", "toA", "panelA", "panelB"] },
      { id: "toB", type: "test.button", props: { event: "press", label: "toB" } },
      { id: "toA", type: "test.button", props: { event: "press", label: "toA" } },
      {
        id: "panelA",
        type: "test.panel",
        props: { text: "Panel A" },
        visibleWhen: { ref: "$state.tab", eq: "a" },
      },
      {
        id: "panelB",
        type: "test.panel",
        props: { text: "Panel B" },
        visibleWhen: { ref: "$state.tab", eq: "b" },
      },
    ],
    events: [
      { on: "toB.press", emit: "state.set", payload: { key: "tab", value: "b" } },
      { on: "toA.press", emit: "state.set", payload: { key: "tab", value: "a" } },
    ],
    provenance: PROVENANCE,
  });
}

function renderSpec(spec: UISpec, onEvent?: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: impls(), theme: {}, onEvent }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("client-local state + visibleWhen", () => {
  it("toggles display via visibleWhen based on the initial state", () => {
    renderSpec(tabSpec(INTENT_A, "a"));
    expect(screen.queryByTestId("panelA")).not.toBeNull();
    expect(screen.queryByTestId("panelB")).toBeNull();
  });

  it("state.set re-renders and is not forwarded to onEvent", () => {
    const onEvent = vi.fn();
    renderSpec(tabSpec(INTENT_A, "a"), onEvent);
    expect(screen.queryByTestId("panelB")).toBeNull();

    fireEvent.click(screen.getByTestId("toB"));

    // The display switches (A hidden / B shown)
    expect(screen.queryByTestId("panelA")).toBeNull();
    expect(screen.queryByTestId("panelB")).not.toBeNull();
    // state.set does not reach the server (onEvent)
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("applying a patch (swapping the spec of the same intent) preserves state", () => {
    const { rerender } = renderSpec(tabSpec(INTENT_A, "a"));
    fireEvent.click(screen.getByTestId("toB"));
    expect(screen.queryByTestId("panelB")).not.toBeNull();

    // Swap the spec with the same intent (A) (even if initialTab is "a", state should be preserved)
    rerender(
      <RendererProvider value={{ impls: impls(), theme: {} }}>
        <SpecView spec={tabSpec(INTENT_A, "a")} />
      </RendererProvider>,
    );
    // tab stays "b" (not overwritten by spec.state's "a")
    expect(screen.queryByTestId("panelB")).not.toBeNull();
    expect(screen.queryByTestId("panelA")).toBeNull();
  });

  it("on an intent.hash change, it reinitializes from spec.state", () => {
    const { rerender } = renderSpec(tabSpec(INTENT_A, "a"));
    fireEvent.click(screen.getByTestId("toB"));
    expect(screen.queryByTestId("panelB")).not.toBeNull();

    // Switch to a different intent (B) → state resets to spec.state ("a")
    rerender(
      <RendererProvider value={{ impls: impls(), theme: {} }}>
        <SpecView spec={tabSpec(INTENT_B, "a")} />
      </RendererProvider>,
    );
    expect(screen.queryByTestId("panelA")).not.toBeNull();
    expect(screen.queryByTestId("panelB")).toBeNull();
  });
});

/** A Spec that toggles display via compound visibleWhen (all / any + numeric comparison). */
function compoundSpec(): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: INTENT_A,
    dataVersion: "v1",
    state: { tab: "a", n: 0 },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["toB", "incN", "both", "either"] },
      { id: "toB", type: "test.button", props: { event: "press", label: "toB" } },
      { id: "incN", type: "test.button", props: { event: "press", label: "incN" } },
      // all: tab === "a" and n >= 5
      {
        id: "both",
        type: "test.panel",
        props: { text: "both" },
        visibleWhen: {
          all: [
            { ref: "$state.tab", eq: "a" },
            { ref: "$state.n", gte: 5 },
          ],
        },
      },
      // any: tab === "b" or n >= 5
      {
        id: "either",
        type: "test.panel",
        props: { text: "either" },
        visibleWhen: {
          any: [
            { ref: "$state.tab", eq: "b" },
            { ref: "$state.n", gte: 5 },
          ],
        },
      },
    ],
    events: [
      { on: "toB.press", emit: "state.set", payload: { key: "tab", value: "b" } },
      { on: "incN.press", emit: "state.set", payload: { key: "n", value: 5 } },
    ],
    provenance: PROVENANCE,
  });
}

describe("display toggling with compound visibleWhen (all / any)", () => {
  it("all / any + numeric comparison follows state updates and toggles display", () => {
    renderSpec(compoundSpec());
    // Initial (tab=a, n=0): both is hidden with n<5, and either is also hidden with tab!=b and n<5
    expect(screen.queryByTestId("both")).toBeNull();
    expect(screen.queryByTestId("either")).toBeNull();

    // Update to n=5 → both (tab=a and n>=5) visible, either (n>=5) visible
    fireEvent.click(screen.getByTestId("incN"));
    expect(screen.queryByTestId("both")).not.toBeNull();
    expect(screen.queryByTestId("either")).not.toBeNull();

    // Update to tab=b → both hidden with tab!=a, either stays visible with tab=b (and n>=5)
    fireEvent.click(screen.getByTestId("toB"));
    expect(screen.queryByTestId("both")).toBeNull();
    expect(screen.queryByTestId("either")).not.toBeNull();
  });
});
