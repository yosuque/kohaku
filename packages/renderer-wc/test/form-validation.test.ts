import { describe, expect, it, vi } from "vitest";
import { buildSpec, byKohaku, mount } from "./util.js";

// Declarative validation of presentForm 1.2.0 (same behavior as renderer-react = shared validateFormValues).
// Without giving a BindingClient, observe "was it submitted" via onEvent forwarding (if invalid, onEvent does not fire).

function formSpec(fields: unknown[]) {
  return buildSpec({
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1"] },
      { id: "f1", type: "presentForm", props: { action: "save", fields } },
    ],
    events: [{ on: "f1.submit", emit: "action.invoke", payload: { v: "$value" } }],
  });
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("Phase 2: presentForm declarative validation", () => {
  it("on violation, does not submit; aggregated error (role=alert) + aria-invalid + inline error + focus move", () => {
    const onEvent = vi.fn();
    const surface = mount(
      formSpec([
        { name: "note", label: "Note", type: "text", required: true },
        { name: "age", label: "Age", type: "number", min: 0, max: 120 },
      ]),
      { onEvent },
    );
    const form = byKohaku(surface, "f1") as HTMLFormElement;

    const age = form.querySelector("#f1-age") as HTMLInputElement;
    age.value = "130";
    age.dispatchEvent(new Event("input", { bubbles: true }));
    submit(form);

    // Not submitted
    expect(onEvent).not.toHaveBeenCalled();

    // Aggregated error: role=alert, count 2, a mention of each field
    const alert = form.querySelector('[role="alert"]')!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain("2");
    expect(alert.textContent).toContain("Note");
    expect(alert.textContent).toContain("Age");

    // note (required) has aria-invalid + an inline error linked via aria-describedby
    const note = form.querySelector("#f1-note") as HTMLInputElement;
    expect(note.getAttribute("aria-invalid")).toBe("true");
    const describedBy = note.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(surface.shadowRoot!.getElementById(describedBy!)?.textContent).toBe("Note is required");

    // age (range violation) also has aria-invalid + the default message
    expect(age.getAttribute("aria-invalid")).toBe("true");
    expect(surface.shadowRoot!.getElementById("f1-age-error")?.textContent).toBe("Age must be 120 or less");

    // Focus moves to the first violating field (note) (the shadow root's activeElement)
    expect(surface.shadowRoot!.activeElement).toBe(note);
  });

  it("when validation passes, submits as usual with no aggregated error / aria-invalid", () => {
    const onEvent = vi.fn();
    const surface = mount(formSpec([{ name: "note", label: "Note", type: "text", required: true }]), {
      onEvent,
    });
    const form = byKohaku(surface, "f1") as HTMLFormElement;
    const note = form.querySelector("#f1-note") as HTMLInputElement;
    note.value = "wrote";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    submit(form);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(form.querySelector('[role="alert"]')).toBeNull();
    expect(note.hasAttribute("aria-invalid")).toBe(false);
  });

  it("violation → fix → resubmit clears the error and submits", () => {
    const onEvent = vi.fn();
    const surface = mount(formSpec([{ name: "note", label: "Note", type: "text", required: true }]), {
      onEvent,
    });
    const form = byKohaku(surface, "f1") as HTMLFormElement;

    submit(form);
    expect(onEvent).not.toHaveBeenCalled();
    expect(form.querySelector('[role="alert"]')).not.toBeNull();

    const note = form.querySelector("#f1-note") as HTMLInputElement;
    note.value = "ok";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    submit(form);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(form.querySelector('[role="alert"]')).toBeNull();
    expect(note.hasAttribute("aria-invalid")).toBe(false);
  });

  it("field.message can override the violation message", () => {
    const onEvent = vi.fn();
    const surface = mount(
      formSpec([{ name: "code", label: "Code", type: "text", required: true, message: "Code required!" }]),
      { onEvent },
    );
    const form = byKohaku(surface, "f1") as HTMLFormElement;
    submit(form);
    expect(surface.shadowRoot!.getElementById("f1-code-error")?.textContent).toBe("Code required!");
    expect(form.querySelector('[role="alert"]')!.textContent).toContain("Code required!");
  });

  it("a form without validation declarations can submit normally (fully backward-compatible)", () => {
    const onEvent = vi.fn();
    const surface = mount(formSpec([{ name: "note", label: "Note", type: "text" }]), { onEvent });
    const form = byKohaku(surface, "f1") as HTMLFormElement;
    submit(form);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(form.querySelector('[role="alert"]')).toBeNull();
  });
});
