import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { UISpec } from "@kohaku-ui/spec-core";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { REGIONS } from "../src/domain/types.js";
import { createHmacAuthzPort } from "../src/ports/authz-port.js";

// e2e for the region cross-filter (A1 two-way binding):
// composing sales.quarterly_summary with a region returns a fixed Spec holding control.select + data.bind(region),
// and the capability issued by compose passes /binding/resolve for all region variants
// (= region switching can be re-resolved without a compose round-trip). A region outside values is 403 (forgery prohibited).

const SECRET = "test-secret";

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
  const authz = createHmacAuthzPort(SECRET);
  return (await createApp({ llm: new FakeLlm(), storage, authz })).app;
}

async function compose(app: Hono, params: Record<string, unknown>) {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: { canonical: "sales.quarterly_summary", params } }),
  });
  return { res, json: (await res.json()) as { spec: UISpec; capability: string } };
}

async function resolveStatus(app: Hono, capability: string, ref: string): Promise<number> {
  const res = await app.request(`/api/kohaku/binding/resolve?ref=${encodeURIComponent(ref)}`, {
    headers: { authorization: `Bearer ${capability}` },
  });
  return res.status;
}

describe("region cross-filter L0 Spec and capability variant", () => {
  it("quarterly_summary with region has control.select + data.bind(region)", async () => {
    const app = await makeApp();
    const { res, json } = await compose(app, {
      fiscalYear: 2026,
      quarter: 3,
      groupBy: "product",
      region: "japan",
    });
    expect(res.status).toBe(200);

    const filter = json.spec.components.find((c) => c.type === "control.select");
    expect(filter).toBeDefined();
    // The state initial value and the control's initial selection match the initial region.
    expect(json.spec.state).toEqual({ region: "japan" });
    expect(filter!.props["value"]).toBe("japan");
    const filterId = filter!.id;

    // The $ref of the components with bind (chart/table) is the region=japan initial variant, and bind.region.values is the region enum.
    const bound = json.spec.components.filter((c) => c.data?.bind != null);
    expect(bound.length).toBeGreaterThanOrEqual(2);
    for (const c of bound) {
      expect(c.data!.$ref).toContain("region=japan");
      expect(c.data!.bind!["region"]).toEqual({ $state: "region", values: REGIONS });
    }
    // control.select's change -> state.set(region) is declared (the input-side binding that completes inside the Renderer).
    // Component IDs are deterministically reassigned by normalizeIds, so match against control.select's actual ID.
    expect(json.spec.events.some((e) => e.on === `${filterId}.change` && e.emit === "state.set")).toBe(true);
  });

  it("a compose-derived capability passes resolve for all region variants (re-resolve without a compose round-trip)", async () => {
    const app = await makeApp();
    const { json } = await compose(app, {
      fiscalYear: 2026,
      quarter: 3,
      groupBy: "product",
      region: "japan",
    });
    const boundRef = json.spec.components.find((c) => c.data?.bind != null)!.data!.$ref;

    // The effective ref with all regions substituted returns 200 (= the client can change $state and re-resolve).
    for (const region of REGIONS) {
      const variant = boundRef.replace(/region=[^&]*/, `region=${region}`);
      expect(await resolveStatus(app, json.capability, variant)).toBe(200);
    }
  });

  it("a region outside values is absent from the capability and returns 403 (no forgery)", async () => {
    const app = await makeApp();
    const { json } = await compose(app, {
      fiscalYear: 2026,
      quarter: 3,
      groupBy: "product",
      region: "japan",
    });
    const boundRef = json.spec.components.find((c) => c.data?.bind != null)!.data!.$ref;

    const forged = boundRef.replace(/region=[^&]*/, "region=zzz");
    expect(await resolveStatus(app, json.capability, forged)).toBe(403);
  });

  it("quarterly_summary without region uses the legacy display (no control.select / bind)", async () => {
    const app = await makeApp();
    const { json } = await compose(app, { fiscalYear: 2026, quarter: 3, groupBy: "region" });
    expect(json.spec.components.some((c) => c.type === "control.select")).toBe(false);
    expect(json.spec.components.some((c) => c.data?.bind != null)).toBe(false);
  });
});
