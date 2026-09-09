// a11y parity: axe-core structural checks over the same golden Spec corpus both renderers already share for
// structural.test.ts / chart.test.ts (SPEC-A11Y-001, spec/SPEC.md §7.1). Running axe on top of the existing
// React ⇄ WC parity harness gets accessibility coverage for both renderers "for free" from a single corpus, and
// keeps the check a regression gate on the reference component set rather than a one-off audit.
//
// Scope: axe.run against jsdom cannot evaluate visually-computed rules (color-contrast, target-size, ...) or
// page-level document/landmark rules (this harness renders an isolated fragment, not a full page) — see
// axe-config.ts for the full list and rationale. Everything else (aria-* validity, role/name-value semantics,
// labels, heading order, table headers, form-control labeling) runs on the full corpus for both renderers.
import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { AXE_OPTIONS } from "./axe-config.js";
import { CHART_CORPUS, corpusBinding, STRUCTURAL_CORPUS } from "./corpus.js";
import { cleanupPair, flushReact, type ParityContext, renderReact, renderWc, tick } from "./render-both.js";

const THEME = {
  "color.text": "#111827",
  "color.muted": "#667085",
  "color.positive": "#15803d",
  "color.negative": "#b91c1c",
};

/** Runs axe against a rendered React fragment and asserts no structural violations remain. */
async function expectNoReactViolations(spec: UISpec, ctx: ParityContext, label: string): Promise<void> {
  const { container } = await renderReact(spec, ctx);
  const results = await axe.run(container, AXE_OPTIONS);
  expect(results.violations, `React ${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

/** Runs axe against a rendered WC fragment (inside its shadow root) and asserts no structural violations remain. */
async function expectNoWcViolations(spec: UISpec, ctx: ParityContext, label: string): Promise<void> {
  const { surface } = await renderWc(spec, ctx);
  const root = surface.shadowRoot!.querySelector(".kohaku-root") as HTMLElement;
  const results = await axe.run(root, AXE_OPTIONS);
  expect(results.violations, `WC ${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
}

describe("a11y parity (SPEC-A11Y-001): axe structural rules over the golden corpus, both renderers", () => {
  afterEach(() => cleanupPair());

  for (const [name, spec] of Object.entries(STRUCTURAL_CORPUS)) {
    it(`structural corpus: ${name}`, async () => {
      const ctx: ParityContext = { binding: corpusBinding, theme: THEME, locale: "ja-JP" };
      await expectNoReactViolations(spec, ctx, name);
      await expectNoWcViolations(spec, ctx, name);
    });
  }

  for (const [name, spec] of Object.entries(CHART_CORPUS)) {
    it(`chart corpus: ${name}`, async () => {
      const ctx: ParityContext = { binding: corpusBinding, theme: THEME };
      await expectNoReactViolations(spec, ctx, name);
      await expectNoWcViolations(spec, ctx, name);
    });
  }
});

// --- Additional DOM states not present in the base (closed/idle) golden corpus ------------------------------
// Cheap to add and worth checking directly: an open overlay.dialog / overlay.toast (role=dialog / role=status
// wiring) and a presentForm validation-error state (role=alert + aria-invalid) are distinct accessibility-tree
// shapes that STRUCTURAL_CORPUS's default (closed / unsubmitted) state never exercises.
const INTENT = { canonical: "parity.a11y_states", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "parity", cache: "hit" } as const;

function stateSpec(partial: {
  components: unknown[];
  events?: unknown[];
  state: Record<string, unknown>;
}): UISpec {
  return parseSpec({
    kohaku: "0.2",
    intent: INTENT,
    dataVersion: "v1",
    state: partial.state,
    components: partial.components,
    events: partial.events ?? [],
    provenance: PROVENANCE,
  });
}

const OPEN_DIALOG_SPEC = stateSpec({
  state: { open: true },
  components: [
    { id: "root", type: "layout.stack", props: {}, children: ["dlg"] },
    {
      id: "dlg",
      type: "overlay.dialog",
      props: { title: "Confirm", description: "Are you sure?" },
      children: ["ok"],
      visibleWhen: { ref: "$state.open", eq: true },
    },
    { id: "ok", type: "action.button", props: { label: "OK" } },
  ],
  events: [{ on: "dlg.close", emit: "state.set", payload: { key: "open", value: false } }],
});

const OPEN_TOAST_SPEC = stateSpec({
  state: { toastOpen: true },
  components: [
    { id: "root", type: "layout.stack", props: {}, children: ["t"] },
    {
      id: "t",
      type: "overlay.toast",
      props: { message: "Saved", tone: "success" },
      visibleWhen: { ref: "$state.toastOpen", eq: true },
    },
  ],
  events: [{ on: "t.dismiss", emit: "state.set", payload: { key: "toastOpen", value: false } }],
});

const VALIDATION_SPEC = parseSpec({
  kohaku: "0.1",
  intent: { canonical: "parity.a11y_form_error", params: {}, hash: "sha256:" + "0".repeat(64) },
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
  provenance: { tier: "L1", composedBy: "parity", cache: "hit" },
});

describe("a11y parity (SPEC-A11Y-001): additional open/error DOM states, both renderers", () => {
  afterEach(() => cleanupPair());

  it("overlay.dialog (open)", async () => {
    const ctx: ParityContext = { theme: {} };
    const { container } = await renderReact(OPEN_DIALOG_SPEC, ctx);
    // Guards against a false-pass: a broken visibleWhen (dialog never rendered) would leave axe
    // with nothing to complain about, so assert the dialog actually exists before checking a11y.
    expect(container.querySelector('[role="dialog"]'), "React: dialog was not rendered").not.toBeNull();
    const reactResults = await axe.run(container, AXE_OPTIONS);
    expect(reactResults.violations, JSON.stringify(reactResults.violations, null, 2)).toEqual([]);
    cleanupPair();

    const { surface } = await renderWc(OPEN_DIALOG_SPEC, ctx);
    const wcRoot = surface.shadowRoot!.querySelector(".kohaku-root") as HTMLElement;
    expect(wcRoot.querySelector('[role="dialog"]'), "WC: dialog was not rendered").not.toBeNull();
    const wcResults = await axe.run(wcRoot, AXE_OPTIONS);
    expect(wcResults.violations, JSON.stringify(wcResults.violations, null, 2)).toEqual([]);
  });

  it("overlay.toast (open)", async () => {
    const ctx: ParityContext = { theme: {} };
    const { container } = await renderReact(OPEN_TOAST_SPEC, ctx);
    // Guards against a false-pass: a broken visibleWhen (toast never rendered) would leave axe
    // with nothing to complain about, so assert the toast actually exists before checking a11y.
    expect(container.querySelector('[role="status"]'), "React: toast was not rendered").not.toBeNull();
    const reactResults = await axe.run(container, AXE_OPTIONS);
    expect(reactResults.violations, JSON.stringify(reactResults.violations, null, 2)).toEqual([]);
    cleanupPair();

    const { surface } = await renderWc(OPEN_TOAST_SPEC, ctx);
    const wcRoot = surface.shadowRoot!.querySelector(".kohaku-root") as HTMLElement;
    expect(wcRoot.querySelector('[role="status"]'), "WC: toast was not rendered").not.toBeNull();
    const wcResults = await axe.run(wcRoot, AXE_OPTIONS);
    expect(wcResults.violations, JSON.stringify(wcResults.violations, null, 2)).toEqual([]);
  });

  it("presentForm (required-field validation error)", async () => {
    const binding = () => ({
      async resolve() {
        return { columns: [], rows: [], dataVersion: "v1" };
      },
      async invokeAction() {
        return { result: { ok: true } };
      },
    });

    const { container } = await renderReact(VALIDATION_SPEC, { binding });
    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);
    await flushReact();
    // Guards against a false-pass: a broken submit handler (no validation ever runs) would leave
    // axe with nothing to complain about, so assert the error state actually rendered first.
    expect(
      container.querySelector('[role="alert"]'),
      "React: aggregated form-error alert was not rendered",
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-invalid="true"]'),
      "React: no field was marked aria-invalid",
    ).not.toBeNull();
    const reactResults = await axe.run(container, AXE_OPTIONS);
    expect(reactResults.violations, JSON.stringify(reactResults.violations, null, 2)).toEqual([]);
    cleanupPair();

    const { surface } = await renderWc(VALIDATION_SPEC, { binding });
    const wcRoot = surface.shadowRoot!;
    (wcRoot.querySelector('form[data-kohaku="f1"]') as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();
    const wcKohakuRoot = wcRoot.querySelector(".kohaku-root") as HTMLElement;
    expect(
      wcKohakuRoot.querySelector('[role="alert"]'),
      "WC: aggregated form-error alert was not rendered",
    ).not.toBeNull();
    expect(
      wcKohakuRoot.querySelector('[aria-invalid="true"]'),
      "WC: no field was marked aria-invalid",
    ).not.toBeNull();
    const wcResults = await axe.run(wcKohakuRoot, AXE_OPTIONS);
    expect(wcResults.violations, JSON.stringify(wcResults.violations, null, 2)).toEqual([]);
  });
});
