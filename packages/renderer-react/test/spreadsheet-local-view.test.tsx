import type { BindingClient } from "@kohaku-ui/data-binding";
import { parseSpec, type TabularData, type UISpec } from "@kohaku-ui/spec-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCoreRegistry } from "../src/core/index.js";
import { RendererProvider, SpecView } from "../src/index.js";

// presentSpreadsheet's local (non-serverSide) truncation footer must be honest even when the source
// reports no total: previously the footer only rendered when data.total was set, so a pageSize
// truncation of an un-totaled reference silently hid rows. localFooterTotal (renderer-core) fixes this
// by falling back to the full local row count as the population when no total is reported.

const REF = "query://sales/records";

function tableData(): TabularData {
  return {
    columns: [{ key: "n", label: "N", type: "number" }],
    rows: [{ n: 1 }, { n: 2 }, { n: 3 }],
    dataVersion: "v1",
    // deliberately no `total`
  };
}

function spec(props: Record<string, unknown>): UISpec {
  return parseSpec({
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    refVersions: { [REF]: "v1" },
    components: [{ id: "root", type: "presentSpreadsheet", props, data: { $ref: REF } }],
    events: [],
    provenance: { tier: "L0", composedBy: "test", cache: "hit" },
  });
}

function fakeBinding(): BindingClient {
  return {
    async resolve() {
      return tableData();
    },
    async invokeAction() {
      return { result: null };
    },
  };
}

describe("presentSpreadsheet local (non-serverSide) truncation footer", () => {
  it("shows an honest footer for a pageSize truncation even when the source reports no total", async () => {
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding: fakeBinding(), theme: {} }}>
        <SpecView spec={spec({ pageSize: 2 })} />
      </RendererProvider>,
    );
    expect(await screen.findByText("Showing 2 of 3 rows")).not.toBeNull();
  });

  it("shows no footer when nothing was truncated", async () => {
    render(
      <RendererProvider value={{ impls: createCoreRegistry(), binding: fakeBinding(), theme: {} }}>
        <SpecView spec={spec({})} />
      </RendererProvider>,
    );
    await screen.findByRole("table");
    expect(screen.queryByText(/Showing \d+ of \d+ rows/)).toBeNull();
  });
});
