// Behavior parity for declarative form validation. Because both renderers share renderer-core's validateFormValues,
// this proves that "required violation → submit not sent + role=alert aggregation + aria-invalid" and "satisfied → invoke sent"
// produce the same external observation.

import type { ActionResult, BindingClient } from "@kohaku-ui/data-binding";
import { type JsonObject, parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPair, flushReact, renderReact, renderWc, tick } from "./render-both.js";

const INTENT = { canonical: "parity.form_validation", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "parity", cache: "hit" } as const;

/** A form with a required note + a ranged age (submit wired to action.invoke). */
function validationSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1"] },
      {
        id: "f1",
        type: "presentForm",
        props: {
          action: "annotate",
          fields: [
            { name: "note", label: "Note", type: "text", required: true },
            { name: "age", label: "Age", type: "number", min: 0, max: 120 },
          ],
        },
      },
    ],
    events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value.note" } }],
    provenance: PROVENANCE,
  });
}

/** A binding that records the sequence of invokeAction calls. */
function recordingBinding(invokes: { action: string; payload: JsonObject }[]): BindingClient {
  return {
    async resolve() {
      return { columns: [], rows: [], dataVersion: "v1" };
    },
    async invokeAction(action, payload): Promise<ActionResult> {
      invokes.push({ action, payload: (payload as JsonObject) ?? {} });
      return { result: { ok: true } };
    },
  };
}

/** Observes the aggregated error (role=alert) + the required field's aria-invalid in both renderers. */
function observe(root: ParentNode): { alertText: string | null; noteInvalid: string | null } {
  const alert = root.querySelector('[role="alert"]');
  const note = root.querySelector("#f1-note");
  return {
    alertText: alert?.textContent ?? null,
    noteInvalid: note?.getAttribute("aria-invalid") ?? null,
  };
}

describe("form validation parity (required violation blocks submit + aggregated error + aria-invalid)", () => {
  afterEach(() => cleanupPair());

  it("submit with an empty required field does not invoke in either renderer and emits role=alert and aria-invalid", async () => {
    // React (controlled input; submit is driven by testing-library's fireEvent)
    const reactInvokes: { action: string; payload: JsonObject }[] = [];
    const { container } = await renderReact(validationSpec(), {
      binding: () => recordingBinding(reactInvokes),
    });
    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);
    await flushReact();

    // WC
    const wcInvokes: { action: string; payload: JsonObject }[] = [];
    const { surface } = await renderWc(validationSpec(), { binding: () => recordingBinding(wcInvokes) });
    const wcRoot = surface.shadowRoot!;
    (wcRoot.querySelector('form[data-kohaku="f1"]') as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    // Neither invokes (submission blocked)
    expect(reactInvokes).toEqual([]);
    expect(wcInvokes).toEqual([]);

    // The aggregated error and aria-invalid are observed identically in both
    const r = observe(container);
    const w = observe(wcRoot);
    expect(r.noteInvalid).toBe("true");
    expect(w.noteInvalid).toBe(r.noteInvalid);
    // The aggregated error includes the count (1) and the required field's label, with identical wording in both
    expect(r.alertText).toContain("Note is required");
    expect(w.alertText).toBe(r.alertText);
  });

  it("a satisfied submit invokes in both renderers and shows no error", async () => {
    // React: fill note and submit (fireEvent handles controlled input and onSubmit)
    const reactInvokes: { action: string; payload: JsonObject }[] = [];
    const { container } = await renderReact(validationSpec(), {
      binding: () => recordingBinding(reactInvokes),
    });
    fireEvent.change(container.querySelector("#f1-note") as HTMLInputElement, {
      target: { value: "Confirm" },
    });
    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);
    await flushReact();

    // WC: the same interaction
    const wcInvokes: { action: string; payload: JsonObject }[] = [];
    const { surface } = await renderWc(validationSpec(), { binding: () => recordingBinding(wcInvokes) });
    const wcRoot = surface.shadowRoot!;
    const wNote = wcRoot.querySelector("#f1-note") as HTMLInputElement;
    wNote.value = "Confirm";
    wNote.dispatchEvent(new Event("input", { bubbles: true }));
    (wcRoot.querySelector('form[data-kohaku="f1"]') as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    // In both, annotate is called once with the note-resolved payload
    expect(reactInvokes).toEqual([{ action: "annotate", payload: { note: "Confirm" } }]);
    expect(wcInvokes).toEqual(reactInvokes);
    // No aggregated (violation) error
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(wcRoot.querySelector('[role="alert"]')).toBeNull();
    // m-19 #3: the post-submit success message (role=status, distinct from the violation-aggregation
    // role=alert above) was previously uncovered by any parity test — each renderer hand-writes its own
    // "succeeded" branch (React's form.tsx / WC's parts/form.ts), so this is the only check standing
    // between the two silently drifting.
    const reactStatus = container.querySelector('[role="status"]');
    const wcStatus = wcRoot.querySelector('[role="status"]');
    expect(reactStatus, "React: no role=status after a successful submit").not.toBeNull();
    expect(wcStatus, "WC: no role=status after a successful submit").not.toBeNull();
    expect(wcStatus!.textContent).toBe(reactStatus!.textContent);
  });

  it("a rejected invokeAction shows role=alert with the failure message in both renderers (m-19 #3)", async () => {
    // Distinct from the required-violation role=alert above (planFormSubmit never runs it, since the
    // required field is filled here): this is the submit-*result* alert, driven by actionState.phase ===
    // "failed" — a separate hand-written role="alert" in both React's form.tsx and WC's parts/form.ts that
    // had no parity coverage at all before this test.
    const failingBinding = (): BindingClient => ({
      async resolve() {
        return { columns: [], rows: [], dataVersion: "v1" };
      },
      async invokeAction(): Promise<ActionResult> {
        throw new Error("save failed");
      },
    });

    const { container } = await renderReact(validationSpec(), { binding: failingBinding });
    fireEvent.change(container.querySelector("#f1-note") as HTMLInputElement, {
      target: { value: "Confirm" },
    });
    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);
    await flushReact();
    const reactAlert = container.querySelector('[role="alert"]');
    expect(reactAlert, "React: no role=alert after a failed submit").not.toBeNull();
    expect(reactAlert!.textContent).toBe("save failed");

    const { surface } = await renderWc(validationSpec(), { binding: failingBinding });
    const wcRoot = surface.shadowRoot!;
    const wNote = wcRoot.querySelector("#f1-note") as HTMLInputElement;
    wNote.value = "Confirm";
    wNote.dispatchEvent(new Event("input", { bubbles: true }));
    (wcRoot.querySelector('form[data-kohaku="f1"]') as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();
    const wcAlert = wcRoot.querySelector('[role="alert"]');
    expect(wcAlert, "WC: no role=alert after a failed submit").not.toBeNull();
    expect(wcAlert!.textContent).toBe(reactAlert!.textContent);
  });
});
