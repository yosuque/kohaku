import type { BindingClient, ResolveOptions } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView, type SurfaceEvent } from "../src/index.js";

const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;
const PROVENANCE = { tier: "L1", composedBy: "test", cache: "hit" } as const;

function formSpec(fields: unknown[], opts?: { events?: unknown[]; data?: string }): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    ...(opts?.data != null ? { refVersions: { [opts.data]: "v1" } } : {}),
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1"] },
      {
        id: "f1",
        type: "presentForm",
        props: { action: "save", fields },
        ...(opts?.data != null ? { data: { $ref: opts.data } } : {}),
      },
    ],
    events: opts?.events ?? [],
    provenance: PROVENANCE,
  });
}

function renderForm(spec: UISpec, opts?: { binding?: BindingClient; onEvent?: (e: SurfaceEvent) => void }) {
  return render(
    <RendererProvider
      value={{
        impls: createCoreRegistry(),
        theme: {},
        ...(opts?.binding != null ? { binding: opts.binding } : {}),
        ...(opts?.onEvent != null ? { onEvent: opts.onEvent } : {}),
      }}
    >
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("PresentForm 1.1.0 extended field types", () => {
  it("renders textarea / radio / multiselect / email / url and ties placeholder / helpText", () => {
    renderForm(
      formSpec([
        { name: "memo", label: "Memo", type: "textarea", placeholder: "Free text", helpText: "Optional" },
        { name: "rating", label: "Rating", type: "radio", options: ["Good", "Fair"] },
        { name: "tags", label: "Tags", type: "multiselect", options: ["a", "b"] },
        { name: "mail", label: "Email", type: "email" },
        { name: "site", label: "Website", type: "url" },
      ]),
    );

    const memo = screen.getByLabelText("Memo") as HTMLTextAreaElement;
    expect(memo.tagName).toBe("TEXTAREA");
    expect(memo.getAttribute("placeholder")).toBe("Free text");
    // helpText is tied via aria-describedby
    const helpId = memo.getAttribute("aria-describedby");
    expect(helpId).not.toBeNull();
    expect(document.getElementById(helpId!)?.textContent).toBe("Optional");

    // The radio group and each radio
    expect(screen.getByRole("group", { name: "Rating" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Good" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Fair" })).toBeDefined();

    // multiselect is a multi-select listbox
    const tags = screen.getByLabelText("Tags") as HTMLSelectElement;
    expect(tags.multiple).toBe(true);

    expect((screen.getByLabelText("Email") as HTMLInputElement).type).toBe("email");
    expect((screen.getByLabelText("Website") as HTMLInputElement).type).toBe("url");
  });

  it("options {value,label} display the label and submit the value", () => {
    const events: SurfaceEvent[] = [];
    const spec = formSpec(
      [{ name: "region", label: "Region", type: "select", options: [{ value: "jp", label: "Japan" }] }],
      { events: [{ on: "f1.submit", emit: "intent.patch", payload: { v: "$value" } }] },
    );
    const { container } = renderForm(spec, { onEvent: (e) => events.push(e) });

    // The option shown with the Japanese label carries value="jp"
    const option = screen.getByRole("option", { name: "Japan" }) as HTMLOptionElement;
    expect(option.value).toBe("jp");

    fireEvent.change(screen.getByLabelText("Region"), { target: { value: "jp" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(events).toHaveLength(1);
    expect((events[0]!.payload["v"] as Record<string, unknown>)["region"]).toBe("jp");
  });

  it("multiselect is coerced to string[]", () => {
    const events: SurfaceEvent[] = [];
    const spec = formSpec([{ name: "tags", label: "Tags", type: "multiselect", options: ["a", "b", "c"] }], {
      events: [{ on: "f1.submit", emit: "intent.patch", payload: { v: "$value" } }],
    });
    const { container } = renderForm(spec, { onEvent: (e) => events.push(e) });

    const select = screen.getByLabelText("Tags") as HTMLSelectElement;
    for (const o of [...select.options]) o.selected = o.value === "a" || o.value === "c";
    fireEvent.change(select);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);

    expect((events[0]!.payload["v"] as Record<string, unknown>)["tags"]).toEqual(["a", "c"]);
  });
});

describe("PresentForm initial value filling from node.data", () => {
  const REF = "query://x/record";
  const DATA: TabularData = {
    columns: [
      { key: "name", label: "Name", type: "string" },
      { key: "region", label: "Region", type: "string" },
    ],
    rows: [{ name: "Acme", region: "jp" }],
    dataVersion: "v1",
  };

  it("while resolving, fields are disabled + aria-busy, and after resolving they fill from the first row (row value > defaultValue)", async () => {
    let resolveData: (d: TabularData) => void = () => {};
    const captured: (string | undefined)[] = [];
    const binding: BindingClient = {
      resolve(_ref, opts?: ResolveOptions) {
        captured.push(opts?.expectedDataVersion);
        return new Promise<TabularData>((r) => {
          resolveData = r;
        });
      },
      async invokeAction() {
        return { result: null };
      },
    };

    const spec = formSpec(
      [
        { name: "name", label: "Name", type: "text" },
        // defaultValue loses if the row has a value (row value > defaultValue)
        { name: "region", label: "Region", type: "select", options: ["jp", "us"], defaultValue: "us" },
      ],
      { data: REF },
    );
    renderForm(spec, { binding });

    // While resolving: inputs are disabled, the form is aria-busy
    const nameLoading = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameLoading.disabled).toBe(true);
    expect(document.querySelector('form[data-kohaku="f1"]')?.getAttribute("aria-busy")).toBe("true");

    // The cross-check target comes from the Spec (refVersions[REF] = "v1")
    await waitFor(() => expect(captured.length).toBeGreaterThan(0));
    expect(captured[0]).toBe("v1");

    resolveData(DATA);

    // After resolving: filled from the first row, and inputs become enabled
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Acme"));
    expect((screen.getByLabelText("Region") as HTMLSelectElement).value).toBe("jp");
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
  });
});
