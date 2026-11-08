import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { TabularData, UISpec } from "@kohaku-ui/spec-core";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// e2e for L1 filter injection (ComposePolicy.l1Filters, enabled in the sample): a screen the (scripted) model
// generated for sales.trend (region=japan) gains control.select + data.bind for the Intent's region facet, and
// the capability issued for it re-resolves every variant WITHOUT another composition (the LLM is called exactly
// once). metric / granularity / groupBy are declared `filterable: false` in the sample catalog -- they rename the
// result's columns, which the chart's x / y props would not follow -- so they are never injected filters.

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue&region=japan";
const REGIONS = ["japan", "north_america", "europe", "apac"];
const TREND_INTENT = { canonical: "sales.trend", params: { region: "japan" } };

function trendDraft(): unknown {
  return {
    components: [
      { id: "root", type: "layout.stack", props: { direction: "vertical", gap: null }, children: ["h", "c"] },
      { id: "h", type: "text.heading", props: { level: 2, text: "Monthly revenue trend" } },
      {
        id: "c",
        type: "presentChart",
        props: { kind: "line", x: "month", y: "revenue", series: null, stacked: null, title: null },
        children: null,
        data: { $ref: TREND_REF },
      },
    ],
    events: [],
  };
}

async function makeApp() {
  const cache = new Map<string, UISpec>();
  const storage = {
    async getSpecCache(k: string) {
      return cache.get(k) ?? null;
    },
    async putSpecCache(k: string, s: UISpec) {
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
  };
  const llm = new FakeLlm({ objects: [trendDraft(), trendDraft()] });
  const built = await createApp({ llm, storage, authz: createHmacAuthzPort("test-secret") });
  return { app: built.app, llm };
}

async function resolveData(
  app: Hono,
  capability: string,
  ref: string,
): Promise<{ status: number; data?: TabularData }> {
  const res = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${capability}` },
  });
  return res.status === 200
    ? { status: 200, data: (await res.json()) as TabularData }
    : { status: res.status };
}

async function resolveStatus(app: Hono, capability: string, ref: string): Promise<number> {
  return (await resolveData(app, capability, ref)).status;
}

describe("L1 filter injection in the sample API", () => {
  it("/compose: injects the shape-stable facet filters and the capability resolves every variant with no further LLM call", async () => {
    const { app, llm } = await makeApp();
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: TREND_INTENT }),
    });
    expect(res.status).toBe(200);
    const { spec, capability } = (await res.json()) as { spec: UISpec; capability: string };
    expect(spec.provenance.tier).toBe("L1");
    expect(llm.calls).toHaveLength(1);

    // Only region is injected: metric / granularity are filterable: false (they rename the result's columns).
    expect(spec.state).toEqual({ region: "japan" });
    const controls = spec.components.filter((c) => c.type === "control.select");
    expect(controls.map((c) => c.id)).toEqual(["filter-region"]);
    const chart = spec.components.find((c) => c.type === "presentChart")!;
    expect(chart.data!.$ref).toBe(TREND_REF);
    expect(Object.keys(chart.data!.bind!)).toEqual(["region"]);

    // Changing the filter = resolving another variant of the same screen: 200 for every authorized value, and the
    // chart's x / y props still name columns of the returned rows (a switched filter never blanks the chart).
    const x = String(chart.props["x"]);
    const y = String(chart.props["y"]);
    for (const region of REGIONS) {
      const ref = `query://sales/trend?granularity=month&metric=revenue&region=${region}`;
      const { status, data } = await resolveData(app, capability, ref);
      expect(status).toBe(200);
      expect(data!.rows.length).toBeGreaterThan(0);
      for (const row of data!.rows) {
        expect(row[x]).not.toBeUndefined();
        expect(row[y]).not.toBeUndefined();
      }
    }
    // ...403 for a value outside the declared domain (no forgery), 403 for the shape-changing variants that are
    // NOT filters any more (the capability signs no scope for them), and still exactly one generation.
    for (const forged of [
      "query://sales/trend?granularity=month&metric=revenue&region=bogus",
      "query://sales/trend?granularity=month&metric=units&region=japan",
      "query://sales/trend?granularity=quarter&metric=revenue&region=japan",
    ]) {
      expect(await resolveStatus(app, capability, forged)).toBe(403);
    }
    expect(llm.calls).toHaveLength(1);
  });

  it("/compose/stream: the final patch's capability covers the filter variants (the skeleton's does not)", async () => {
    const { app, llm } = await makeApp();
    const res = await app.request("/api/kohaku/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: TREND_INTENT }),
    });
    expect(res.status).toBe(200);
    const events: { event: string; data: Record<string, unknown> }[] = [];
    for (const block of (await res.text()).split("\n\n")) {
      const lines = block.split("\n");
      const event = lines
        .find((l) => l.startsWith("event:"))
        ?.slice("event:".length)
        .trim();
      const data = lines.find((l) => l.startsWith("data:"));
      if (event != null && data != null) {
        events.push({
          event,
          data: JSON.parse(data.slice("data:".length).trim()) as Record<string, unknown>,
        });
      }
    }
    const skeletonCap = events.find((e) => e.event === "spec")!.data["capability"] as string;
    const finalCap = events.filter((e) => e.event === "patch").at(-1)!.data["capability"] as string;
    expect(typeof finalCap).toBe("string");

    const variant = "query://sales/trend?granularity=month&metric=revenue&region=europe";
    expect(await resolveStatus(app, skeletonCap, variant)).toBe(403);
    expect(await resolveStatus(app, finalCap, variant)).toBe(200);
    expect(llm.calls).toHaveLength(1);
  });

  it("a Japanese session gets Japanese filter labels (session.locale reaches describeFilters) and is cached separately", async () => {
    const { app } = await makeApp();
    const compose = async (locale: string) => {
      const res = await app.request("/api/kohaku/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intent: TREND_INTENT,
          session: { surface: "web", locale },
        }),
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { spec: UISpec };
    };
    const labels = (spec: UISpec): Record<string, unknown> =>
      Object.fromEntries(
        spec.components.filter((c) => c.type === "control.select").map((c) => [c.id, c.props["label"]]),
      );
    const ja = await compose("ja");
    expect(labels(ja.spec)).toEqual({ "filter-region": "地域" });
    const en = await compose("en");
    expect(labels(en.spec)).toEqual({ "filter-region": "Region" });
  });
});
