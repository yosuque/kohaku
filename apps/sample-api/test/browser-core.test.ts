import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { UISpec } from "@kohaku-ui/spec-core";
import { createMemoryStoragePort } from "@kohaku-ui/storage-memory/memory";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp, SalesRepo, type SalesSeedInput } from "../src/browser.js";
import { fiscalYearOf, quarterOf } from "../src/domain/types.js";

/**
 * Exercises the exact entry point the static playground (apps/playground) uses: `../src/browser.js` (the `./browser`
 * package export), with an injected seed (no disk read), no l2Smoke (no jsdom/node:vm dependency reachable
 * here), and a fixed `now` (as the playground must, so a ReplayLlm fixture's key — derived from the NL
 * normalization prompt text — matches what was recorded). None of this file's imports come from `app.ts`'s
 * Node-only default path (`createDefaultRepo`'s dynamic import of `domain/seed-fs.js`) or from
 * `@kohaku-ui/authz-jwt` — the playground's strict build (design.md decision 57) verifies that at the bundler level instead.
 */

const FIXED_NOW = new Date("2026-11-15T00:00:00Z");

const SEED: SalesSeedInput = {
  products: [{ id: "p1", name: "Widget", category: "hardware", unitPrice: 1000 }],
  records: [
    {
      id: "r1",
      fiscalYear: 2026,
      quarter: 3,
      month: "2026-10",
      region: "japan",
      productId: "p1",
      channel: "direct",
      units: 10,
      revenue: 10_000,
    },
  ],
  targets: [{ fiscalYear: 2026, quarter: 3, region: "japan", targetRevenue: 5000 }],
  // A caller supplying its own seed picks its own stable tag (see SalesSeedInput's doc); this is not
  // derived from any disk content, unlike readSeedFromDisk's SEED_VERSION + contentHash scheme.
  seedTag: "browser-core-test-fixture",
};

async function makeBrowserApp(objects: unknown[] = []) {
  const llm = new FakeLlm({ objects });
  const storage = createMemoryStoragePort();
  const authz = createHmacAuthzPort("test-secret");
  const repo = new SalesRepo(SEED);
  const app = await createApp({ llm, storage, authz, repo, now: () => FIXED_NOW });
  return { ...app, llm };
}

async function composeJson(app: Hono, body: unknown) {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as { spec: UISpec } };
}

describe("browser core (the ./browser export, as the static playground will use it)", () => {
  it("boots with an injected seed instead of reading disk", async () => {
    const { repo } = await makeBrowserApp();
    expect(repo.records).toHaveLength(1);
    // The dataVersion carries the injected seedTag, not a disk-derived one (proves the dynamic-import
    // default path in app.ts's createDefaultRepo was never reached).
    expect(repo.dataVersion()).toBe("sales@browser-core-test-fixture#bump-0");
  });

  it("an L0 fixed-spec GUI compose succeeds without any LLM call", async () => {
    const { app, llm } = await makeBrowserApp();
    const { res, json } = await composeJson(app, {
      input: {
        kind: "gui",
        action: "view.select",
        params: { intent: "sales.quarterly_summary", fiscalYear: 2026, quarter: 3, groupBy: "region" },
      },
    });
    expect(res.status).toBe(200);
    expect(json.spec.provenance.tier).toBe("L0");
    expect(llm.calls).toHaveLength(0);
  });

  it("the fixed `now` reaches the NL-normalization prompt (not the real current date)", async () => {
    const { app, llm } = await makeBrowserApp([{ intent: "sales.quarterly_summary", params: {} }]);
    const res = await app.request("/api/kohaku/intent/normalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { kind: "nl", text: "this quarter's summary" } }),
    });
    expect(res.status).toBe(200);
    // salesRules(now) embeds "FY<fiscalYear>"/"quarter=<quarter>" into the *system* prompt
    // (semantic-llm's buildNormalizeSystemPrompt; ports/semantic-port.ts's fiscalPeriodOf reads the
    // *local* calendar date — see its own doc comment) — present only when `now` really drove it, since
    // FIXED_NOW (2026-11-15T00:00Z) is nowhere near today's real date.
    const fiscalYear = fiscalYearOf(FIXED_NOW.getFullYear(), FIXED_NOW.getMonth() + 1);
    const quarter = quarterOf(FIXED_NOW.getMonth() + 1);
    const system = llm.calls[0]!.system!;
    expect(system).toContain(`FY${fiscalYear}`);
    expect(system).toContain(`quarter=${quarter}`);
  });
});
