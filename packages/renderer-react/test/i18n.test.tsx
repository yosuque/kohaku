import type { BindingClient } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { type RendererMessages, RendererProvider, SpecView } from "../src/index.js";

const REF = "query://ledger/x";

const SHEET_DATA: TabularData = {
  columns: [{ key: "revenue", label: "Revenue", type: "number" }],
  rows: [{ revenue: 1234567 }],
  total: 5,
  dataVersion: "v1",
};

function binding(): BindingClient {
  return {
    async resolve() {
      return SHEET_DATA;
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

const PROVENANCE = { tier: "L1", composedBy: "test", cache: "hit" } as const;
const INTENT = { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) } as const;

function sheetSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["t1"] },
      { id: "t1", type: "presentSpreadsheet", props: {}, data: { $ref: REF } },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

function formSpec(): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: INTENT,
    dataVersion: "v1",
    components: [
      { id: "root", type: "layout.stack", props: {}, children: ["f1"] },
      {
        id: "f1",
        type: "presentForm",
        props: { fields: [{ name: "region", label: "Region", type: "select", options: ["japan"] }] },
      },
    ],
    events: [],
    provenance: PROVENANCE,
  });
}

function renderWith(spec: UISpec, opts?: { locale?: string; messages?: Partial<RendererMessages> }) {
  return render(
    <RendererProvider
      value={{
        impls: createCoreRegistry(),
        binding: binding(),
        theme: {},
        locale: opts?.locale,
        messages: opts?.messages,
      }}
    >
      <SpecView spec={spec} />
    </RendererProvider>,
  );
}

describe("i18n wiring (messages / locale)", () => {
  it("unspecified uses the default English messages (Submit / Select an option)", () => {
    renderWith(formSpec());
    expect(screen.getByRole("button", { name: "Submit" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Select an option" })).toBeDefined();
  });

  it("overriding messages changes the wording (submit / select placeholder / spreadsheet total)", async () => {
    renderWith(formSpec(), {
      messages: { formSubmit: "送信", formSelectPlaceholder: "選択してください" },
    });
    expect(screen.getByRole("button", { name: "送信" })).toBeDefined();
    expect(screen.getByRole("option", { name: "選択してください" })).toBeDefined();

    // Overriding spreadsheetTotal (a function message) is also reflected
    renderWith(sheetSpec(), {
      messages: { spreadsheetTotal: (total, shown) => `${shown} of ${total}` },
    });
    await waitFor(() => expect(screen.getByText("1 of 5")).toBeDefined());
  });

  it("locale changes number formatting (default en-US uses comma separators / de-DE uses period separators)", async () => {
    // Integer thousands separators are identical in en-US and ja-JP, so verify locale passthrough with de-DE where the difference is observable.
    const sheet = () => within(document.querySelector('[data-kohaku="t1"]') as HTMLElement);

    const defaultLocale = renderWith(sheetSpec());
    await waitFor(() => expect(sheet().getByText("1,234,567")).toBeDefined());
    defaultLocale.unmount();

    renderWith(sheetSpec(), { locale: "de-DE" });
    await waitFor(() => expect(sheet().getByText("1.234.567")).toBeDefined());
  });
});
