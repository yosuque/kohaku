import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
// Run conformance against the sample implementation as the subject (in-repo self-test).
import { createApp } from "../../apps/sample-api/src/app.js";
import { buildReport, runRestSuite, runSpecFormatSuite } from "../conformance/index.js";

function memoryStorage() {
  const cache = new Map<string, UISpec>();
  return {
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
}

describe("conformance", () => {
  it("the Spec format self-check (equivalent to --self) satisfies all MUSTs", async () => {
    const report = buildReport(await runSpecFormatSuite());
    for (const r of report.results) {
      expect(r.pass, `${r.id}: ${r.detail ?? ""}`).toBe(true);
    }
  });

  it("the sample REST host satisfies all MUSTs of the REST profile", async () => {
    const { app } = await createApp({
      llm: new FakeLlm({ objects: [] }), // no LLM needed since only the L0 fixed view is used
      storage: memoryStorage(),
      authz: createHmacAuthzPort("conformance-secret"),
    });

    const results = await runRestSuite({
      fetch: async (path, init) => app.request(`/api/kohaku${path}`, init),
      composeIntent: {
        canonical: "sales.quarterly_summary",
        params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
      },
    });
    // REST-EVT-001 is a MUST. With a canonical Intent that has events, it must be actually checked, not skipped (which would count as a pass).
    const evt = results.find((r) => r.id === "REST-EVT-001");
    expect(evt?.skipped ?? false).toBe(false);

    const report = buildReport([...(await runSpecFormatSuite()), ...results]);
    for (const r of report.results) {
      expect(r.pass, `${r.id}: ${r.detail ?? ""}`).toBe(true);
    }
    expect(report.pass).toBe(true);
  });
});
