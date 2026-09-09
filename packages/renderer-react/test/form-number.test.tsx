import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

// A minimal spec with one number field. On submit, receive the coerced value via $value.
function formSpec(): UISpec {
  return parseSpec({
    ...fixture,
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["form1"] },
      {
        id: "form1",
        type: "presentForm",
        props: { fields: [{ name: "amount", label: "Amount", type: "number" }] },
      },
    ],
    events: [{ on: "form1.submit", emit: "intent.patch", payload: { result: "$value" } }],
  });
}

function renderForm(onEvent: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), theme: {}, onEvent }}>
      <SpecView spec={formSpec()} />
    </RendererProvider>,
  );
}

describe("PresentForm number input (keeps intermediate state via text + inputMode)", () => {
  it("the number field input is type=text / inputMode=decimal (the display does not vanish on intermediate strings)", () => {
    renderForm(() => {});
    const input = screen.getByLabelText("Amount", { exact: false }) as HTMLInputElement;
    expect(input.getAttribute("type")).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("decimal");

    // Even entering an intermediate string like "1.", the value is kept as-is (with type=number it would reset to empty).
    fireEvent.change(input, { target: { value: "1." } });
    expect(input.value).toBe("1.");
    fireEvent.change(input, { target: { value: "1.5" } });
    expect(input.value).toBe("1.5");
  });

  it('entering "1.5" and submitting makes payload a number 1.5', () => {
    const events: SurfaceEvent[] = [];
    const { container } = renderForm((e) => events.push(e));
    const input = screen.getByLabelText("Amount", { exact: false }) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "1.5" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(events).toHaveLength(1);
    const result = events[0]!.payload["result"] as Record<string, unknown>;
    expect(result["amount"]).toBe(1.5);
    expect(typeof result["amount"]).toBe("number");
  });

  it('"-" alone or an empty string cannot be numeric, so becomes null', () => {
    const events: SurfaceEvent[] = [];
    const { container } = renderForm((e) => events.push(e));
    const input = screen.getByLabelText("Amount", { exact: false }) as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.change(input, { target: { value: "-" } });
    fireEvent.submit(form);
    expect((events[0]!.payload["result"] as Record<string, unknown>)["amount"]).toBeNull();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.submit(form);
    expect((events[1]!.payload["result"] as Record<string, unknown>)["amount"]).toBeNull();
  });
});

// Series sort stability: verify that series with numeric labels are in natural order, not lexical order ("10" < "2").
const SERIES_DATA: TabularData = {
  columns: [
    { key: "month", label: "Month", type: "string" },
    { key: "team", label: "Team", type: "string" },
    { key: "value", label: "Value", type: "number" },
  ],
  // Deliberately set first-appearance order to 2 → 10 → 1 to also ensure it does not depend on first-appearance order.
  rows: [
    { month: "M1", team: "2", value: 20 },
    { month: "M1", team: "10", value: 100 },
    { month: "M1", team: "1", value: 10 },
  ],
  dataVersion: "v1",
};

describe("PresentChart series sort (numeric labels in natural order)", () => {
  it("series y keys are stable in numeric natural order (1,2,10), not lexical order", async () => {
    const { prepareRowsForTest } = await import("../src/core/chart.js");
    const { yKeys } = prepareRowsForTest(SERIES_DATA.rows, "month", "value", "team");
    expect(yKeys).toEqual(["1", "2", "10"]);
  });
});
