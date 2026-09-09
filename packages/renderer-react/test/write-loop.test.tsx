import type { ActionResult, BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { BindingError } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { type RendererContextValue, RendererProvider, SpecView } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L0", composedBy: "test", cache: "hit" } as const;
const REF = "query://sales/summary?fy=2026";

function dataAt(version: string): TabularData {
  return {
    columns: [{ key: "region", label: "Region", type: "string" }],
    rows: [{ region: "japan" }],
    dataVersion: version,
  };
}

/** A Spec with a form (write) + a distant table (subscribing to REF). */
function formAndTableSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    refVersions: { [REF]: "v1" },
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1", "t1"] },
      {
        id: "f1",
        type: "presentForm",
        props: {
          action: "annotate",
          successMessage: "Saved",
          fields: [{ name: "note", type: "text", label: "Memo" }],
        },
      },
      { id: "t1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
    ],
    events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value" } }],
    provenance: PROVENANCE,
  });
}

/** A form-only Spec with no table (so no table error notice appears even without a binding). */
function formOnlySpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1"] },
      {
        id: "f1",
        type: "presentForm",
        props: { action: "annotate", fields: [{ name: "note", type: "text", label: "Memo" }] },
      },
    ],
    events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value" } }],
    provenance: PROVENANCE,
  });
}

function renderSpec(spec: UISpec, ctx: Partial<RendererContextValue>) {
  return render(
    <RendererProvider value={{ impls: createCoreRegistry(), theme: {}, ...ctx }}>
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("useInvokeAction (write loop)", () => {
  it("success → succeeded display + onActionResult + invalidates re-resolves a distant table (refVersions cross-check)", async () => {
    let version = "v1";
    const captured: (string | undefined)[] = [];
    const binding: BindingClient = {
      resolve(_ref, opts?: ResolveOptions) {
        captured.push(opts?.expectedDataVersion);
        return Promise.resolve(dataAt(version));
      },
      async invokeAction(action): Promise<ActionResult> {
        expect(action).toBe("annotate");
        version = "v2"; // the write advances the data version
        return { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "v2" } };
      },
    };
    const onActionResult = vi.fn();
    const { container } = renderSpec(formAndTableSpec(), { binding, onActionResult });

    // Initial resolve (v1)
    await waitFor(() => expect(captured.length).toBe(1));
    expect(captured[0]).toBe("v1");

    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);

    // Success message (role=status)
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
    // onActionResult once on success
    expect(onActionResult).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: "f1", action: "annotate", phase: "succeeded" }),
    );
    // The distant table re-resolves via the invalidate bus (2nd time). The cross-check target is refVersions' "v2"
    await waitFor(() => expect(captured.length).toBe(2));
    expect(captured[1]).toBe("v2");
    // The table renders without becoming STALE
    expect(screen.queryByText(/Data has been updated/)).toBeNull();
    const table = within(document.querySelector('[data-kohaku="t1"]') as HTMLElement);
    expect(table.getByText("japan")).toBeDefined();
  });

  it("when invalidates has no refVersions, the re-resolve cross-check is skipped (do not make one's own write STALE)", async () => {
    let version = "v1";
    const captured: (string | undefined)[] = [];
    const binding: BindingClient = {
      resolve(_ref, opts?: ResolveOptions) {
        captured.push(opts?.expectedDataVersion);
        return Promise.resolve(dataAt(version));
      },
      async invokeAction(): Promise<ActionResult> {
        version = "v2"; // the data version advances but refVersions is not returned
        return { result: null, invalidates: [REF] };
      },
    };
    const { container } = renderSpec(formAndTableSpec(), { binding });

    await waitFor(() => expect(captured.length).toBe(1));
    expect(captured[0]).toBe("v1");

    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);

    // The re-resolve cross-check target is undefined (= skip cross-check). Even with data version v2, it does not become STALE.
    await waitFor(() => expect(captured.length).toBe(2));
    expect(captured[1]).toBeUndefined();
    expect(screen.queryByText(/Data has been updated/)).toBeNull();
  });

  it("failure → failed display (role=alert) + onActionResult(failed). resubmittable", async () => {
    const binding: BindingClient = {
      async resolve() {
        return dataAt("v1");
      },
      async invokeAction(): Promise<ActionResult> {
        throw new BindingError("RESOLVE_FAILED", "Failed to write");
      },
    };
    const onActionResult = vi.fn();
    const { container } = renderSpec(formAndTableSpec(), { binding, onActionResult });

    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Failed to write"));
    expect(onActionResult).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: "f1", action: "annotate", phase: "failed" }),
    );
    // After failure, the submit button is still enabled (resubmittable)
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("payload's $value.<field> extracts a single form field (passes the note string to annotate)", async () => {
    // Same shape as the sales.records demo: payload = { note: "$value.note", refs: [REF] }.
    // Verifies that a single field (not the whole $value value object) can be placed as the action's argument.
    const spec = parseSpec({
      kohaku: "0.1",
      intent: INTENT,
      dataVersion: "v1",
      refVersions: { [REF]: "v1" },
      components: [
        { id: "root", type: "layout.stack", props: {}, children: ["f1", "t1"] },
        {
          id: "f1",
          type: "presentForm",
          props: { action: "annotate", fields: [{ name: "note", type: "text", label: "Memo" }] },
        },
        { id: "t1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
      ],
      events: [{ on: "f1.submit", emit: "action.invoke", payload: { note: "$value.note", refs: [REF] } }],
      provenance: PROVENANCE,
    });
    let captured: unknown = null;
    const binding: BindingClient = {
      async resolve() {
        return dataAt("v1");
      },
      async invokeAction(action, payload): Promise<ActionResult> {
        captured = { action, payload };
        return { result: { ok: true }, invalidates: [REF], refVersions: { [REF]: "v1" } };
      },
    };
    const { container } = renderSpec(spec, { binding });

    const input = container.querySelector("#f1-note") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Check North America" } });
    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);

    await waitFor(() => expect(captured).not.toBeNull());
    // note is the input's string itself (not the whole value object). refs is passed as the static array as-is.
    expect(captured).toEqual({ action: "annotate", payload: { note: "Check North America", refs: [REF] } });
  });

  it("without a BindingClient it falls back to onEvent forwarding (state stays idle)", () => {
    const onEvent = vi.fn();
    const { container } = renderSpec(formOnlySpec(), { onEvent });
    fireEvent.submit(container.querySelector('form[data-kohaku="f1"]') as HTMLFormElement);

    // action.invoke is forwarded to onEvent (not executed directly)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ componentId: "f1", on: "f1.submit", emit: "action.invoke" }),
    );
    // No success/failure message appears (state is idle)
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
