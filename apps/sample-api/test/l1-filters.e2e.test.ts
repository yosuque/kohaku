import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { UISpec } from "@kohaku-ui/spec-core";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

// e2e for L1 filter injection (ComposePolicy.l1Filters, enabled in the sample): a screen the (scripted) model
// generated for sales.trend gains control.select + data.bind for the Intent's metric / granularity facets, and the
// capability issued for it re-resolves every variant WITHOUT another composition (the LLM is called exactly once).

const TREND_REF = "query://sales/trend?granularity=month&metric=revenue";

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
  const llm = new FakeLlm({ objects: [trendDraft()] });
  const built = await createApp({ llm, storage, authz: createHmacAuthzPort("test-secret") });
  return { app: built.app, llm };
}

async function resolveStatus(app: Hono, capability: string, ref: string): Promise<number> {
  const res = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${capability}` },
  });
  return res.status;
}

describe("L1 filter injection in the sample API", () => {
  it("/compose: injects the facet filters and the capability resolves every variant with no further LLM call", async () => {
    const { app, llm } = await makeApp();
    const res = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
    });
    expect(res.status).toBe(200);
    const { spec, capability } = (await res.json()) as { spec: UISpec; capability: string };
    expect(spec.provenance.tier).toBe("L1");
    expect(llm.calls).toHaveLength(1);

    // metric and granularity are in the ref and declared as vocabulary facets; region / productId are not in the ref.
    expect(spec.state).toEqual({ granularity: "month", metric: "revenue" });
    const controls = spec.components.filter((c) => c.type === "control.select");
    expect(controls.map((c) => c.id).sort()).toEqual(["filter-granularity", "filter-metric"]);
    const chart = spec.components.find((c) => c.type === "presentChart")!;
    expect(chart.data!.$ref).toBe(TREND_REF);
    expect(Object.keys(chart.data!.bind!).sort()).toEqual(["granularity", "metric"]);

    // Changing a filter = resolving another variant of the same screen: 200 for every authorized value...
    for (const metric of ["revenue", "units"]) {
      for (const granularity of ["month", "quarter"]) {
        const ref = `query://sales/trend?granularity=${granularity}&metric=${metric}`;
        expect(await resolveStatus(app, capability, ref)).toBe(200);
      }
    }
    // ...403 for a value outside the declared domain (no forgery), and still exactly one generation.
    expect(await resolveStatus(app, capability, "query://sales/trend?granularity=month&metric=bogus")).toBe(
      403,
    );
    expect(llm.calls).toHaveLength(1);
  });

  it("/compose/stream: the final patch's capability covers the filter variants (the skeleton's does not)", async () => {
    const { app, llm } = await makeApp();
    const res = await app.request("/api/kohaku/compose/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: {} } }),
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

    const variant = "query://sales/trend?granularity=quarter&metric=units";
    expect(await resolveStatus(app, skeletonCap, variant)).toBe(403);
    expect(await resolveStatus(app, finalCap, variant)).toBe(200);
    expect(llm.calls).toHaveLength(1);
  });
});
