import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "test", cache: "hit" } as const;

// A minimal spec that flows submit to intent.patch (observe "was it submitted" via onEvent).
function formSpec(fields: unknown[]): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1"] },
      { id: "f1", type: "presentForm", props: { action: "save", fields } },
    ],
    events: [{ on: "f1.submit", emit: "intent.patch", payload: { v: "$value" } }],
    provenance: PROVENANCE,
  });
}

function renderForm(spec: UISpec, onEvent: (e: SurfaceEvent) => void) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), theme: {}, onEvent }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("PresentForm 1.2.0 declarative validation", () => {
  it("on violation it does not submit, and shows an aggregated error (role=alert) + aria-invalid + inline errors + focus move", () => {
    const events: SurfaceEvent[] = [];
    const { container } = renderForm(
      formSpec([
        { name: "note", label: "Memo", type: "text", required: true },
        { name: "age", label: "Age", type: "number", min: 0, max: 120 },
      ]),
      (e) => events.push(e),
    );

    // Submit with age out of range and note left empty
    fireEvent.change(screen.getByLabelText("Age", { exact: false }), { target: { value: "130" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    // Not submitted (onEvent not reached)
    expect(events).toEqual([]);

    // Aggregated error: role=alert, includes the count 2, mentions each field
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("2");
    expect(alert.textContent).toContain("Memo");
    expect(alert.textContent).toContain("Age");

    // note (required) has aria-invalid + an inline error tied via aria-describedby
    const note = screen.getByLabelText("Memo", { exact: false }) as HTMLInputElement;
    expect(note.getAttribute("aria-invalid")).toBe("true");
    const describedBy = note.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Memo is required");

    // age (range violation) also has aria-invalid + the default message
    const age = screen.getByLabelText("Age", { exact: false }) as HTMLInputElement;
    expect(age.getAttribute("aria-invalid")).toBe("true");
    const ageErr = document.getElementById(`${age.id}-error`);
    expect(ageErr?.textContent).toBe("Age must be 120 or less");

    // Focus moves to the first violating field (note)
    expect(document.activeElement).toBe(note);
  });

  it("if validation passes it submits normally, with no aggregated error / aria-invalid", () => {
    const events: SurfaceEvent[] = [];
    const { container } = renderForm(
      formSpec([{ name: "note", label: "Memo", type: "text", required: true }]),
      (e) => events.push(e),
    );

    fireEvent.change(screen.getByLabelText("Memo", { exact: false }), { target: { value: "written" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect(events).toHaveLength(1);
    expect((events[0]!.payload["v"] as Record<string, unknown>)["note"]).toBe("written");
    expect(screen.queryByRole("alert")).toBeNull();
    const note = screen.getByLabelText("Memo", { exact: false }) as HTMLInputElement;
    expect(note.hasAttribute("aria-invalid")).toBe(false);
  });

  it("violation → fix → resubmit clears the error and submits", () => {
    const events: SurfaceEvent[] = [];
    const { container } = renderForm(
      formSpec([{ name: "note", label: "Memo", type: "text", required: true }]),
      (e) => events.push(e),
    );
    const form = container.querySelector("form") as HTMLFormElement;

    // 1st time: empty, so a violation
    fireEvent.submit(form);
    expect(events).toEqual([]);
    expect(screen.getByRole("alert")).toBeDefined();

    // Fix and resubmit → error disappears, submission succeeds
    fireEvent.change(screen.getByLabelText("Memo", { exact: false }), { target: { value: "ok" } });
    fireEvent.submit(form);
    expect(events).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      (screen.getByLabelText("Memo", { exact: false }) as HTMLInputElement).hasAttribute("aria-invalid"),
    ).toBe(false);
  });

  it("field.message can override the violation message", () => {
    const events: SurfaceEvent[] = [];
    const { container } = renderForm(
      formSpec([{ name: "code", label: "Code", type: "text", required: true, message: "Code is required!" }]),
      (e) => events.push(e),
    );
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    const code = screen.getByLabelText("Code", { exact: false }) as HTMLInputElement;
    expect(document.getElementById(`${code.id}-error`)?.textContent).toBe("Code is required!");
    expect(screen.getByRole("alert").textContent).toContain("Code is required!");
  });
});
