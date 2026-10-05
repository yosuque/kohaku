import type { ActionResult, BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { BindingError } from "@kohaku-ui/data-binding";
import type { ActionManifest } from "@kohaku-ui/renderer-core";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** A Spec with a single actionButton (action.button) wired to action.invoke. */
function actionButtonSpec(action = "annotate"): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["b1"] },
      { id: "b1", type: "action.button", props: { action, label: "Go" } },
    ],
    events: [{ on: "b1.press", emit: "action.invoke", payload: { note: "hi" } }],
    provenance: PROVENANCE,
  });
}

describe("useInvokeAction: governed actions (design.md #62/#63)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a locally-invalid payload (per actionManifest) never calls binding.invokeAction", async () => {
    const invokeAction = vi.fn(async (): Promise<ActionResult> => ({ result: { ok: true } }));
    const binding: BindingClient = {
      resolve: async () => {
        throw new Error("not used in these tests");
      },
      invokeAction,
    };
    const manifest: ActionManifest = {
      annotate: {
        tier: "auto",
        paramsSchema: { type: "object", properties: { note: { type: "string", maxLength: 1 } } },
      },
    };
    const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest });
    fireEvent.click(container.querySelector('[data-kohaku="b1"]') as HTMLButtonElement);
    await waitFor(() => expect(container.querySelector('[data-kohaku="b1"]')).not.toBeNull());
    expect(invokeAction).not.toHaveBeenCalled();
  });

  it("tier confirm with no host confirm hook defaults to globalThis.confirm — accepted", async () => {
    const invokeAction = vi.fn(async (): Promise<ActionResult> => ({ result: { ok: true } }));
    const binding: BindingClient = {
      resolve: async () => {
        throw new Error("not used in these tests");
      },
      invokeAction,
    };
    const manifest: ActionManifest = { annotate: { tier: "confirm" } };
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest });
    fireEvent.click(container.querySelector('[data-kohaku="b1"]') as HTMLButtonElement);
    await waitFor(() => expect(invokeAction).toHaveBeenCalled());
    expect(confirmSpy).toHaveBeenCalledWith('Proceed with "annotate"?');
    expect(invokeAction).toHaveBeenCalledWith(
      "annotate",
      { note: "hi" },
      { confirmed: true, approval: undefined },
    );
  });

  it("tier confirm with no host confirm hook defaults to globalThis.confirm — declined", async () => {
    const invokeAction = vi.fn(async (): Promise<ActionResult> => ({ result: { ok: true } }));
    const binding: BindingClient = {
      resolve: async () => {
        throw new Error("not used in these tests");
      },
      invokeAction,
    };
    const manifest: ActionManifest = { annotate: { tier: "confirm" } };
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest });
    fireEvent.click(container.querySelector('[data-kohaku="b1"]') as HTMLButtonElement);
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeAction).not.toHaveBeenCalled();
  });

  it("a host-supplied confirm hook takes priority over globalThis.confirm", async () => {
    const invokeAction = vi.fn(async (): Promise<ActionResult> => ({ result: { ok: true } }));
    const binding: BindingClient = {
      resolve: async () => {
        throw new Error("not used in these tests");
      },
      invokeAction,
    };
    const manifest: ActionManifest = { annotate: { tier: "confirm", confirmMessage: "Sure?" } };
    const globalConfirm = vi.fn(() => true);
    vi.stubGlobal("confirm", globalConfirm);
    const confirm = vi.fn(async () => true);
    const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest, confirm });
    fireEvent.click(container.querySelector('[data-kohaku="b1"]') as HTMLButtonElement);
    await waitFor(() => expect(invokeAction).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledWith({ action: "annotate", message: "Sure?" });
    expect(globalConfirm).not.toHaveBeenCalled();
  });

  it("tier approve invokes with the requestApproval hook's token", async () => {
    const invokeAction = vi.fn(async (): Promise<ActionResult> => ({ result: { ok: true } }));
    const binding: BindingClient = {
      resolve: async () => {
        throw new Error("not used in these tests");
      },
      invokeAction,
    };
    const manifest: ActionManifest = { annotate: { tier: "approve" } };
    const requestApproval = vi.fn(async () => "kohaku-approval.v1.tok");
    const { container } = renderSpec(actionButtonSpec(), {
      binding,
      actionManifest: manifest,
      requestApproval,
    });
    fireEvent.click(container.querySelector('[data-kohaku="b1"]') as HTMLButtonElement);
    await waitFor(() => expect(invokeAction).toHaveBeenCalled());
    expect(requestApproval).toHaveBeenCalledWith({ action: "annotate", payload: { note: "hi" } });
    expect(invokeAction).toHaveBeenCalledWith(
      "annotate",
      { note: "hi" },
      { confirmed: undefined, approval: "kohaku-approval.v1.tok" },
    );
  });

  it("tier approve with no requestApproval hook still asks the server once, without an approval token", async () => {
    const invokeAction = vi.fn(async (): Promise<ActionResult> => {
      throw new BindingError("APPROVAL_REQUIRED", "this action requires an approval token", { status: 403 });
    });
    const binding: BindingClient = {
      resolve: async () => {
        throw new Error("not used in these tests");
      },
      invokeAction,
    };
    const manifest: ActionManifest = { annotate: { tier: "approve" } };
    const onActionResult = vi.fn();
    const { container } = renderSpec(actionButtonSpec(), {
      binding,
      actionManifest: manifest,
      onActionResult,
    });
    fireEvent.click(container.querySelector('[data-kohaku="b1"]') as HTMLButtonElement);
    await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(1));
    expect(invokeAction).toHaveBeenCalledWith(
      "annotate",
      { note: "hi" },
      { confirmed: undefined, approval: undefined },
    );
    // Awaiting approval is not a completed write: no completion notification.
    await new Promise((r) => setTimeout(r, 0));
    expect(onActionResult).not.toHaveBeenCalled();
  });

  describe("default requestApproval hook (globalThis.prompt, design.md #72)", () => {
    const APPROVAL = {
      requestId: "req-42",
      action: "annotate",
      tier: "approve",
      payloadHash: `sha256:${"ab".repeat(32)}`,
    } as const;

    /** invokeAction that answers APPROVAL_REQUIRED until it is given an approval token, then succeeds. */
    function gatedBinding() {
      const invokeAction = vi.fn(async (_action: string, _payload: unknown, opts?: { approval?: string }) => {
        if (opts?.approval == null) {
          throw new BindingError("APPROVAL_REQUIRED", "this action requires an approval token", {
            status: 403,
            approval: APPROVAL,
          });
        }
        return { result: { ok: true } } as ActionResult;
      });
      const binding: BindingClient = {
        resolve: async () => {
          throw new Error("not used in these tests");
        },
        invokeAction: invokeAction as BindingClient["invokeAction"],
      };
      return { binding, invokeAction };
    }

    const manifest: ActionManifest = { annotate: { tier: "approve" } };
    // The notice is on screen and the invoke that produced it has fully settled (phase back to awaitingApproval).
    const settled = async () => {
      await screen.findByRole("status");
      await new Promise((r) => setTimeout(r, 0));
    };
    const click = (container: HTMLElement) =>
      fireEvent.click(container.querySelector('[data-kohaku="b1"]') as HTMLButtonElement);

    it("does not prompt on the first click: the request reaches the server exactly once, without a token", async () => {
      const prompt = vi.fn(() => "should-not-be-used");
      vi.stubGlobal("prompt", prompt);
      const { binding, invokeAction } = gatedBinding();
      const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest });
      click(container);
      await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(1));
      await screen.findByRole("status");
      expect(prompt).not.toHaveBeenCalled();
      expect(invokeAction).toHaveBeenCalledWith(
        "annotate",
        { note: "hi" },
        { confirmed: undefined, approval: undefined },
      );
    });

    it("prompts on the click after awaitingApproval and sends the pasted token as `approval`", async () => {
      const prompt = vi.fn(() => "  kohaku-approval.v1.pasted  ");
      vi.stubGlobal("prompt", prompt);
      const { binding, invokeAction } = gatedBinding();
      const onActionResult = vi.fn();
      const { container } = renderSpec(actionButtonSpec(), {
        binding,
        actionManifest: manifest,
        onActionResult,
      });
      click(container);
      await screen.findByRole("status");
      click(container);
      await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(2));
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledWith(
        'Paste the approval token for "annotate" (ask an approver; see Admin › Approvals)',
      );
      expect(invokeAction).toHaveBeenLastCalledWith(
        "annotate",
        { note: "hi" },
        { confirmed: undefined, approval: "kohaku-approval.v1.pasted" },
      );
      await waitFor(() =>
        expect(onActionResult).toHaveBeenCalledWith(
          expect.objectContaining({ action: "annotate", phase: "succeeded" }),
        ),
      );
    });

    it("resends without a token when the prompt is cancelled (or left empty)", async () => {
      const prompt = vi.fn((): string | null => null);
      vi.stubGlobal("prompt", prompt);
      const { binding, invokeAction } = gatedBinding();
      const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest });
      click(container);
      await screen.findByRole("status");
      click(container);
      await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(2));
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(invokeAction).toHaveBeenLastCalledWith(
        "annotate",
        { note: "hi" },
        { confirmed: undefined, approval: undefined },
      );
      prompt.mockReturnValueOnce("   ");
      await settled();
      click(container);
      await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(3));
      expect(invokeAction).toHaveBeenLastCalledWith(
        "annotate",
        { note: "hi" },
        { confirmed: undefined, approval: undefined },
      );
    });

    it("falls back to the tokenless request when prompt throws or is missing", async () => {
      const { binding, invokeAction } = gatedBinding();
      const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest });
      click(container);
      await screen.findByRole("status");
      vi.stubGlobal("prompt", () => {
        throw new Error("blocked in a sandboxed iframe");
      });
      click(container);
      await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(2));
      await settled();
      vi.stubGlobal("prompt", undefined);
      click(container);
      await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(3));
      for (const call of invokeAction.mock.calls) {
        expect(call[2]).toEqual({ confirmed: undefined, approval: undefined });
      }
    });

    it("a host-supplied requestApproval wins over the default and is asked every time", async () => {
      const prompt = vi.fn(() => "from-prompt");
      vi.stubGlobal("prompt", prompt);
      const { binding, invokeAction } = gatedBinding();
      const requestApproval = vi.fn(async () => "from-host");
      const { container } = renderSpec(actionButtonSpec(), {
        binding,
        actionManifest: manifest,
        requestApproval,
      });
      click(container);
      await waitFor(() => expect(invokeAction).toHaveBeenCalledTimes(1));
      expect(requestApproval).toHaveBeenCalledTimes(1);
      expect(invokeAction).toHaveBeenLastCalledWith(
        "annotate",
        { note: "hi" },
        { confirmed: undefined, approval: "from-host" },
      );
      expect(prompt).not.toHaveBeenCalled();
    });

    it("the awaiting notice names the request and the payload hash for the approver", async () => {
      const { binding } = gatedBinding();
      const { container } = renderSpec(actionButtonSpec(), { binding, actionManifest: manifest });
      click(container);
      const notice = await screen.findByRole("status");
      expect(notice.textContent).toContain("request req-42");
      expect(notice.textContent).toContain(
        `payload ${APPROVAL.payloadHash.replace(/^sha256:/, "").slice(0, 12)}`,
      );
      expect(notice.textContent).not.toContain(APPROVAL.payloadHash);
    });
  });
});
