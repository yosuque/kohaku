import { type ComponentNode, parseSpec, SANDBOX_HTML_TYPE, type UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { coreCatalog, defineComponent, negotiate, resolveCatalog } from "../src/index.js";

const catalog = resolveCatalog(coreCatalog);
const spec = () => {
  const parsed = parseSpec(fixture);
  // negotiate expects a version-resolved Spec (after catalog validation)
  return { ...parsed, components: catalog.validate(parsed.components).normalized };
};

describe("negotiate (capability negotiation)", () => {
  it("no changes on a surface that supports all parts", () => {
    const { spec: out, downgrades } = negotiate(spec(), catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        "text.heading": "^1.0.0",
        presentChart: "^1.0.0",
        presentSpreadsheet: "^1.0.0",
        presentMarkdown: "^1.0.0",
      },
    });
    expect(downgrades).toEqual([]);
    expect(out).toEqual(spec());
  });

  it("presentChart unsupported → downgrades to presentSpreadsheet via the fallback chain and carries over data", () => {
    const { spec: out, downgrades } = negotiate(spec(), catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        "text.heading": "^1.0.0",
        presentSpreadsheet: "^1.0.0",
        presentMarkdown: "^1.0.0",
      },
    });
    expect(downgrades).toEqual([
      { id: "chart1", from: "presentChart", to: "presentSpreadsheet", reason: expect.any(String) },
    ]);
    const chart = out.components.find((c) => c.id === "chart1");
    expect(chart?.type).toBe("presentSpreadsheet");
    expect(chart?.data?.$ref).toBeDefined();
    expect(out.provenance.fallback?.from).toContain("chart1:presentChart");
    expect(out.provenance.fallback?.kind).toBe("negotiation");
  });

  it("falls to the presentMarkdown terminal when the chain is exhausted", () => {
    const { spec: out, downgrades } = negotiate(spec(), catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        "text.heading": "^1.0.0",
        presentMarkdown: "^1.0.0",
      },
    });
    expect(downgrades.map((d) => `${d.id}:${d.to}`).sort()).toEqual([
      "chart1:presentMarkdown",
      "table1:presentMarkdown",
    ]);
    expect(out.components.every((c) => c.type !== "presentChart")).toBe(true);
  });

  it("a version that does not satisfy the semver range is treated as unsupported", () => {
    const { downgrades } = negotiate(spec(), catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        "text.heading": "^1.0.0",
        presentChart: "^2.0.0", // the catalog has 1.0.0
        presentSpreadsheet: "^1.0.0",
        presentMarkdown: "^1.0.0",
      },
    });
    expect(downgrades.some((d) => d.id === "chart1")).toBe(true);
  });

  it("a node downgraded to a children:none part drops children (symmetric with data, R1)", () => {
    // presentList (children:optional) → fallback presentSpreadsheet (children:none).
    // Unconditionally carrying children over on downgrade would leave children on a children:none part, an inconsistency.
    const listSpec: UISpec = {
      kohaku: "0.2",
      intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
      dataVersion: "v1",
      components: [
        { id: "root", type: "layout.stack", version: "1.0.0", props: {}, children: ["list1"] },
        { id: "item1", type: "text.heading", version: "1.0.0", props: { text: "Row" } },
        {
          id: "list1",
          type: "presentList",
          version: "1.0.0",
          props: {},
          children: ["item1"],
          data: { $ref: "query://sales/summary?fy=2026" },
        },
      ],
      events: [],
      provenance: { tier: "L1", composedBy: "test", cache: "miss" },
    };
    const { spec: out, downgrades } = negotiate(listSpec, catalog, {
      supports: {
        "layout.stack": "^1.0.0",
        "text.heading": "^1.0.0",
        presentSpreadsheet: "^1.0.0",
        presentMarkdown: "^1.0.0",
        // presentList is not supported → downgrade to presentSpreadsheet (children:none)
      },
    });
    expect(downgrades).toEqual([
      { id: "list1", from: "presentList", to: "presentSpreadsheet", reason: expect.any(String) },
    ]);
    const list = out.components.find((c) => c.id === "list1");
    expect(list?.type).toBe("presentSpreadsheet");
    // The downgrade target is children:none, so children are dropped (data remains since presentSpreadsheet accepts it)
    expect(list?.children).toBeUndefined();
    expect(list?.data?.$ref).toBe("query://sales/summary?fy=2026");
  });
});

/** A minimal L2 free-form node (sandbox.html; catalog-independent — negotiate special-cases it by type). */
function sandboxSpec(): UISpec {
  const sandboxNode: ComponentNode = {
    id: "widget1",
    type: SANDBOX_HTML_TYPE,
    props: {},
    artifact: { inline: "<div>widget</div>", sha256: "0".repeat(64) },
  };
  return {
    kohaku: "0.1",
    intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "v1",
    components: [sandboxNode],
    events: [],
    provenance: { tier: "L2", composedBy: "test", cache: "miss" },
  };
}

describe("negotiate: L2 (sandbox.html) tier gating", () => {
  it("maxTier:'L1' downgrades the L2 node to presentMarkdown, recording the reason", () => {
    const { spec: out, downgrades } = negotiate(sandboxSpec(), catalog, {
      supports: { presentMarkdown: "^1.0.0" },
      maxTier: "L1",
    });
    expect(downgrades).toEqual([
      {
        id: "widget1",
        from: SANDBOX_HTML_TYPE,
        to: "presentMarkdown",
        reason: expect.any(String),
      },
    ]);
    const node = out.components.find((c) => c.id === "widget1");
    expect(node?.type).toBe("presentMarkdown");
  });

  it("an unspecified maxTier defaults to L2 and leaves the sandbox node unchanged", () => {
    const { spec: out, downgrades } = negotiate(sandboxSpec(), catalog, {
      supports: { presentMarkdown: "^1.0.0" },
    });
    expect(downgrades).toEqual([]);
    expect(out.components.find((c) => c.id === "widget1")?.type).toBe(SANDBOX_HTML_TYPE);
  });

  it("maxTier:'L2' explicitly leaves the sandbox node unchanged", () => {
    const { spec: out, downgrades } = negotiate(sandboxSpec(), catalog, {
      supports: { presentMarkdown: "^1.0.0" },
      maxTier: "L2",
    });
    expect(downgrades).toEqual([]);
    expect(out.components.find((c) => c.id === "widget1")?.type).toBe(SANDBOX_HTML_TYPE);
  });
});

describe("negotiate: fallback-chain cycle guard (visited)", () => {
  it("a→b→a fallback cycle terminates at presentMarkdown instead of looping forever", () => {
    const a = defineComponent({
      type: "test.cycleA",
      version: "1.0.0",
      description: "cycle test A",
      propsSchema: z.object({}),
      capabilities: { events: [], data: "none", children: "none" },
      fallback: { type: "test.cycleB", mapProps: (props) => props },
    });
    const b = defineComponent({
      type: "test.cycleB",
      version: "1.0.0",
      description: "cycle test B",
      propsSchema: z.object({}),
      capabilities: { events: [], data: "none", children: "none" },
      fallback: { type: "test.cycleA", mapProps: (props) => props },
    });
    const cycleCatalog = resolveCatalog(coreCatalog, { components: [a, b] });

    const spec: UISpec = {
      kohaku: "0.1",
      intent: { canonical: "x.y", params: {}, hash: "sha256:" + "0".repeat(64) },
      dataVersion: "v1",
      components: [{ id: "n1", type: "test.cycleA", version: "1.0.0", props: {} }],
      events: [],
      provenance: { tier: "L1", composedBy: "test", cache: "miss" },
    };

    // Neither test.cycleA nor test.cycleB is supported by this surface, so following the fallback chain
    // would loop forever (a -> b -> a -> ...) without the `visited` guard in negotiate.ts.
    const { spec: out, downgrades } = negotiate(spec, cycleCatalog, {
      supports: { presentMarkdown: "^1.0.0" },
    });
    expect(downgrades).toEqual([
      { id: "n1", from: "test.cycleA", to: "presentMarkdown", reason: expect.any(String) },
    ]);
    expect(out.components.find((c) => c.id === "n1")?.type).toBe("presentMarkdown");
  });
});
