import type { ComposeContext } from "@kohaku-ui/composer";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import { parseSpec, type UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import fixture from "../../../spec/examples/quarterly-sales.spec.json";
import { normalizeForMatch, runGolden, specsMatch } from "../src/index.js";

// Use the same ledger ref as the canonical fixture
const REF = "query://ledger/sales_summary?fy=2026&groupBy=region&q=3";

function makeCtx(objects: unknown[]): ComposeContext {
  const cache = new Map<string, UISpec>();
  return {
    catalog: resolveCatalog(coreCatalog),
    llm: new FakeLlm({ objects }),
    semantic: {
      async normalize() {
        return { canonical: "sales.quarterly_summary", params: {}, hash: "" };
      },
      async resolveQuery() {
        return { uri: REF };
      },
      async dataVersion() {
        return "sales@seed-1";
      },
    },
    storage: {
      async getSpecCache(k) {
        return cache.get(k) ?? null;
      },
      async putSpecCache(k, s) {
        cache.set(k, s);
      },
      async appendLineage() {},
      async listLineage() {
        return [];
      },
      async getPromotionState() {
        return null;
      },
      async putPromotionState() {},
      async listPromotionStates() {
        return [];
      },
      async getFixation() {
        return null;
      },
      async putFixation() {},
      async listFixations() {
        return [];
      },
    },
  };
}

function rawDraft(ids: [string, string, string, string]): unknown {
  return {
    components: [
      {
        id: ids[0],
        type: "layout.stack",
        props: { direction: "vertical", gap: null },
        children: [ids[1], ids[2], ids[3]],
      },
      { id: ids[1], type: "text.heading", props: { level: 2, text: "FY2026 Q3 Sales (by Region)" } },
      {
        id: ids[2],
        type: "presentChart",
        props: { kind: "bar", x: "region", y: "revenue", series: null, stacked: null, title: null },
        children: null,
        data: { $ref: REF },
      },
      {
        id: ids[3],
        type: "presentSpreadsheet",
        props: { editable: false, columns: null, sortBy: null, pageSize: null },
        children: null,
        data: { $ref: REF },
      },
    ],
    events: [
      {
        on: `${ids[3]}.rowClick`,
        emit: "intent.patch",
        payload: [{ key: "drilldown", value: "$row.region" }],
      },
    ],
  };
}

describe("Golden Spec regression", () => {
  it("absorbs ID/provenance/dataVersion variance via normalization to judge a match", () => {
    const a = parseSpec(fixture);
    const b: UISpec = {
      ...a,
      dataVersion: "ledger@other-version",
      provenance: { tier: "L1", composedBy: "composer@9.9.9", cache: "miss" },
      // Even with different IDs, positional normalization treats them as identical
      components: a.components.map((c) => ({
        ...c,
        id: c.id === "root" ? "root" : `x_${c.id}`,
        ...(c.children != null ? { children: c.children.map((x) => `x_${x}`) } : {}),
      })),
      events: a.events.map((e) => ({ ...e, on: `x_${e.on}` })),
    };
    expect(specsMatch(b, a)).toBe(true);
    // Differences in props are detected
    const c: UISpec = {
      ...a,
      components: a.components.map((x) =>
        x.id === "chart1" ? { ...x, props: { ...x.props, kind: "pie" } } : x,
      ),
    };
    expect(specsMatch(c, a)).toBe(false);
  });

  it("runGolden: composer output matches the expected Spec (deterministic with FakeLlm)", async () => {
    const expected = parseSpec(fixture);
    const ctx = makeCtx([rawDraft(["root", "a", "b", "c"])]);
    const report = await runGolden(
      [
        {
          name: "sales.quarterly_summary FY2026 Q3 region",
          input: {
            kind: "intent",
            intent: {
              canonical: "sales.quarterly_summary",
              params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
            },
          },
          // Match the expected value to the shape with catalog defaults already filled in
          // (this ctx has no describeShape, so automatic sortBy filling does not run)
          expected: {
            ...expected,
            components: resolveCatalog(coreCatalog).validate(expected.components).normalized,
          },
        },
      ],
      ctx,
    );
    if (!report.pass) {
      // Make the diff on failure easier to read
      console.log("expected:", report.cases[0]?.expected);
      console.log("actual:", report.cases[0]?.actual);
    }
    expect(report.pass).toBe(true);
  });

  it("normalizeForMatch is deterministic (same input → same string)", () => {
    const spec = parseSpec(fixture);
    expect(normalizeForMatch(spec)).toBe(normalizeForMatch(parseSpec(fixture)));
  });
});
