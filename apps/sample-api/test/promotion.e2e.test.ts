import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import type { UISpec } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import type { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const L2_HTML =
  "<!DOCTYPE html><html><head><title>Sales calendar heatmap</title></head><body><div id=hm></div><script>window.kohaku.fetchData('query://sales/trend?fy=2026&granularity=month&metric=revenue').then(function(d){document.getElementById('hm').textContent=d.rows.length+' months';window.kohaku.ready();});</script></body></html>";

/**
 * NL normalization script for sales.custom (the generateObject side).
 * L2 generation now goes through the generateText (raw HTML) path, so it is not stacked in objects;
 * each FakeLlm responds with texts: () => L2_HTML (a count-independent function script).
 */
function customScripts(): unknown[] {
  return [
    // 1st call: NL -> sales.custom
    { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } },
    // 2nd NL call (cache hit, so L2 generation does not run)
    { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } },
  ];
}

async function ask(app: Hono, text: string, sessionId: string): Promise<UISpec> {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { kind: "nl", text }, session: { surface: "chat", sessionId } }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { spec: UISpec }).spec;
}

describe("promotion pipeline E2E (L2 -> approve -> L1 part + dynamic Intent + persistence across restart)", () => {
  it("used twice -> candidate -> approve -> reflected in catalog/Intent -> persisted", async () => {
    const dataDir = tmpDir("kohaku-promo-");
    const storage = createFileStoragePort(dataDir);
    const authz = createHmacAuthzPort("test-secret");

    // A judge response is also needed (LLM-as-Judge runs on approve)
    const llm = new FakeLlm({
      objects: [
        ...customScripts(),
        {
          criteria: [
            { id: "safety", score: 0.9, reasoning: "uses kohaku API only" },
            { id: "determinism", score: 0.8, reasoning: "no randomness" },
            { id: "a11y", score: 0.7, reasoning: "has text" },
            { id: "schema_inferability", score: 0.8, reasoning: "parameterizable" },
            { id: "generality", score: 0.8, reasoning: "general-purpose" },
            { id: "suggestion_fidelity", score: 1, reasoning: "no proposal" },
          ],
          summary: "worthy of promotion",
        },
      ],
      texts: () => L2_HTML,
    });
    const { app } = await createApp({ llm, storage, authz });

    // 1. The same free-form request twice (the 2nd is a cache hit; usage is recorded twice)
    const first = await ask(app, "Sales as a calendar heatmap", "s1");
    expect(first.provenance.tier).toBe("L2");
    const second = await ask(app, "Sales as a calendar heatmap", "s2");
    expect(second.provenance.cache).toBe("hit");

    // 2. Candidate listing (threshold minUses=2 is met -> becomes a candidate).
    //    The side effect of auto-nomination (nominate) has been separated into POST /promotions/evaluate.
    const promotionsRes = await app.request("/api/kohaku/promotions/evaluate", { method: "POST" });
    const { candidates } = (await promotionsRes.json()) as {
      candidates: { artifactId: string; status: string; uses: number; html?: string; request?: string }[];
    };
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe("candidate");
    expect(candidates[0]!.uses).toBe(2);
    expect(candidates[0]!.html).toContain("kohaku.fetchData");
    const artifactId = candidates[0]!.artifactId;

    // 2.5. Preview: returns the material to reproduce the review target itself (the recorded artifact),
    //      and the issued read capability can actually resolve the data of the generation-time ref (the whole Plan 2 loop).
    const previewRes = await app.request(`/api/kohaku/promotions/${artifactId}/preview`, {
      method: "POST",
    });
    expect(previewRes.status).toBe(200);
    const { preview } = (await previewRes.json()) as {
      preview: { html: string; sha256: string; ref?: string; capability?: string };
    };
    expect(preview.html).toBe(candidates[0]!.html);
    // ref matches the data.$ref of the sandbox node at L2 generation time (a prerequisite for reproduction mount).
    const sandboxNode = first.components.find((c) => c.artifact != null)!;
    expect(preview.sha256).toBe(sandboxNode.artifact!.sha256);
    expect(preview.ref).toBe(sandboxNode.data?.$ref);
    const resolveRes = await app.request(
      `/api/kohaku/binding/resolve?ref=${encodeURIComponent(preview.ref!)}`,
      { headers: { authorization: `Bearer ${preview.capability}` } },
    );
    expect(resolveRes.status).toBe(200);
    // The issued capability is limited to the preview's ref (a different ref is 403 = forgery remains prohibited).
    const otherRes = await app.request(
      `/api/kohaku/binding/resolve?ref=${encodeURIComponent("query://sales/records?limit=10")}`,
      { headers: { authorization: `Bearer ${preview.capability}` } },
    );
    expect(otherRes.status).toBe(403);

    // 3. Approval (judge -> human approval -> schema finalized -> publish)
    const draft = {
      componentType: "sales.calendarHeatmap",
      version: "1.0.0",
      intentName: "sales.calendar_heatmap",
      description: "Display sales as a monthly calendar heatmap",
    };
    const approveRes = await app.request(`/api/kohaku/promotions/${artifactId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft }),
    });
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as {
      candidate: { status: string; verdict?: { pass: boolean } };
    };
    expect(approved.candidate.status).toBe("published");
    expect(approved.candidate.verdict?.pass).toBe(true);

    // 4. The promoted component appears in the catalog and also merges into the Intent catalog
    const catalog = (await (await app.request("/api/kohaku/catalog")).json()) as {
      components: { type: string; implementation: { kind: string } }[];
    };
    const promoted = catalog.components.find((c) => c.type === "sales.calendarHeatmap");
    expect(promoted).toBeDefined();
    expect(promoted!.implementation.kind).toBe("sandbox-template");

    const health = (await (await app.request("/api/health")).json()) as { intents: string[] };
    expect(health.intents).toContain("sales.calendar_heatmap");

    // 5. Lineage has the full provenance of the promotion (LIN-PRM-001: reviewed/approve before published)
    const lineageRes = await app.request(`/api/kohaku/lineage?artifactId=${artifactId}&limit=50`);
    const { events } = (await lineageRes.json()) as { events: { type: string }[] };
    const types = events.map((e) => e.type);
    const reviewedAt = types.indexOf("component.reviewed");
    const publishedAt = types.indexOf("component.published");
    expect(reviewedAt).toBeGreaterThan(-1);
    expect(publishedAt).toBeGreaterThan(reviewedAt);

    // 6. The promotion persists after a restart (a new app with the same dataDir)
    const llm2 = new FakeLlm({ objects: [] });
    const storage2 = createFileStoragePort(dataDir);
    const { app: app2 } = await createApp({ llm: llm2, storage: storage2, authz });
    const health2 = (await (await app2.request("/api/health")).json()) as {
      intents: string[];
      promoted: string[];
    };
    expect(health2.intents).toContain("sales.calendar_heatmap");
    expect(health2.promoted).toContain("sales.calendarHeatmap");
  });

  it("rejection flow: review.reject terminates as rejected", async () => {
    const dataDir = tmpDir("kohaku-promo-");
    const storage = createFileStoragePort(dataDir);
    const llm = new FakeLlm({ objects: customScripts(), texts: () => L2_HTML });
    const { app } = await createApp({ llm, storage, authz: createHmacAuthzPort("s") });

    await ask(app, "Sales as a calendar heatmap", "s1");
    await ask(app, "Sales as a calendar heatmap", "s2");
    const { candidates } = (await (
      await app.request("/api/kohaku/promotions/evaluate", { method: "POST" })
    ).json()) as { candidates: { artifactId: string }[] };

    const rejectRes = await app.request(`/api/kohaku/promotions/${candidates[0]!.artifactId}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const rejected = (await rejectRes.json()) as { candidate: { status: string } };
    expect(rejected.candidate.status).toBe("rejected");
  });

  it("withdrawal (unpublish): published -> REST withdraw -> removed from catalog/Intent (the promotions.json snapshot)", async () => {
    const dataDir = tmpDir("kohaku-unpub-");
    const storage = createFileStoragePort(dataDir);
    const authz = createHmacAuthzPort("test-secret");
    const llm = new FakeLlm({
      objects: [
        ...customScripts(),
        {
          criteria: [
            { id: "safety", score: 0.9, reasoning: "uses kohaku API only" },
            { id: "determinism", score: 0.8, reasoning: "no randomness" },
            { id: "a11y", score: 0.7, reasoning: "has text" },
            { id: "schema_inferability", score: 0.8, reasoning: "parameterizable" },
            { id: "generality", score: 0.8, reasoning: "general-purpose" },
            { id: "suggestion_fidelity", score: 1, reasoning: "no proposal" },
          ],
          summary: "worthy of promotion",
        },
      ],
      texts: () => L2_HTML,
    });
    const { app } = await createApp({ llm, storage, authz });

    // Advance through publish (usage twice -> candidate -> approval).
    await ask(app, "Sales as a calendar heatmap", "s1");
    await ask(app, "Sales as a calendar heatmap", "s2");
    const { candidates } = (await (
      await app.request("/api/kohaku/promotions/evaluate", { method: "POST" })
    ).json()) as { candidates: { artifactId: string }[] };
    const artifactId = candidates[0]!.artifactId;
    const draft = {
      componentType: "sales.calendarHeatmap",
      version: "1.0.0",
      intentName: "sales.calendar_heatmap",
      description: "Display sales as a monthly calendar heatmap",
    };
    const approved = await app.request(`/api/kohaku/promotions/${artifactId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft }),
    });
    expect(approved.status).toBe(200);

    // After publish: the promoted component is in the catalog; record its fingerprint.
    const catalogBefore = (await (await app.request("/api/kohaku/catalog")).json()) as {
      components: { type: string }[];
      catalogVersion: string;
    };
    expect(catalogBefore.components.some((c) => c.type === "sales.calendarHeatmap")).toBe(true);
    const fpPublished = catalogBefore.catalogVersion;

    // Compose the promoted Intent (the LLM script is exhausted, so L1 falls to the deterministic fallback).
    // This fallback Spec is cached under the post-publish fingerprint.
    const beforeWithdraw = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.calendar_heatmap", params: { fiscalYear: 2026 } } }),
    });
    expect(beforeWithdraw.status).toBe(200);

    // Withdraw (the REST named route).
    const withdrawRes = await app.request(`/api/kohaku/promotions/${artifactId}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "demo takedown" }),
    });
    expect(withdrawRes.status).toBe(200);
    const withdrawn = (await withdrawRes.json()) as { candidate: { status: string } };
    expect(withdrawn.candidate.status).toBe("withdrawn");

    // The promoted component disappears from /catalog, and catalogVersion (the fingerprint) changes.
    const catalogAfter = (await (await app.request("/api/kohaku/catalog")).json()) as {
      components: { type: string }[];
      catalogVersion: string;
    };
    expect(catalogAfter.components.some((c) => c.type === "sales.calendarHeatmap")).toBe(false);
    expect(catalogAfter.catalogVersion).not.toBe(fpPublished);

    // Compose of the same Intent is not "cache-reused". Because the fingerprint changes and the
    // publish-time cache becomes unreachable, and because the promoted Intent itself is removed so
    // resolveQuery can no longer resolve, the compose that was 200 (fallback) before withdrawal becomes
    // 500 after withdrawal (if the cache were reused, it would keep returning 200).
    const afterWithdraw = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.calendar_heatmap", params: { fiscalYear: 2026 } } }),
    });
    expect(afterWithdraw.status).toBe(500);

    // Lineage retains component.withdrawn (from:"published").
    const lineageRes = await app.request(`/api/kohaku/lineage?artifactId=${artifactId}&limit=50`);
    const { events } = (await lineageRes.json()) as {
      events: { type: string; payload: Record<string, unknown> }[];
    };
    const withdrawnEvent = events.find((e) => e.type === "component.withdrawn");
    expect(withdrawnEvent?.payload["from"]).toBe("published");

    // The withdrawal persists after a restart (same dataDir): it is gone from the promotions.json snapshot / dynamic Intent.
    const storage2 = createFileStoragePort(dataDir);
    const { app: app2 } = await createApp({ llm: new FakeLlm({ objects: [] }), storage: storage2, authz });
    const health2 = (await (await app2.request("/api/health")).json()) as {
      intents: string[];
      promoted: string[];
    };
    expect(health2.promoted).not.toContain("sales.calendarHeatmap");
    expect(health2.intents).not.toContain("sales.calendar_heatmap");
  });
});

describe("promotion draft wiring (paramsJsonSchema + queryTemplate)", () => {
  it("approve with a draft -> catalog propsSchema reflected and compose data.$ref is the expected URI", async () => {
    const dataDir = tmpDir("kohaku-draft-");
    const storage = createFileStoragePort(dataDir);
    const authz = createHmacAuthzPort("test-secret");
    const expectedRef = "query://sales/trend?fy=2026&granularity=month&metric=revenue";
    // L1-generated draft for the promoted Intent (sales.calendar_heatmap). data.$ref must match the
    // resolved URI derived from queryTemplate (the enum constraint of the generation schema), or it is rejected in validation.
    const heatmapL1Draft = {
      components: [
        { id: "root", type: "layout.stack", props: { direction: "vertical", gap: null }, children: ["c"] },
        {
          id: "c",
          type: "presentChart",
          props: { kind: "line", x: "month", y: "revenue", series: null, stacked: null, title: null },
          children: null,
          data: { $ref: expectedRef },
        },
      ],
      events: [],
    };
    const llm = new FakeLlm({
      objects: [
        ...customScripts(),
        {
          criteria: [
            { id: "safety", score: 0.9, reasoning: "uses kohaku API only" },
            { id: "determinism", score: 0.8, reasoning: "no randomness" },
            { id: "a11y", score: 0.7, reasoning: "has text" },
            { id: "schema_inferability", score: 0.8, reasoning: "parameterizable" },
            { id: "generality", score: 0.8, reasoning: "general-purpose" },
            { id: "suggestion_fidelity", score: 1, reasoning: "no proposal" },
          ],
          summary: "worthy of promotion",
        },
        heatmapL1Draft,
      ],
      texts: () => L2_HTML,
    });
    const { app } = await createApp({ llm, storage, authz });

    // Publish (usage twice -> candidate -> approval).
    await ask(app, "Sales as a calendar heatmap", "s1");
    await ask(app, "Sales as a calendar heatmap", "s2");
    const { candidates } = (await (
      await app.request("/api/kohaku/promotions/evaluate", { method: "POST" })
    ).json()) as { candidates: { artifactId: string }[] };
    const artifactId = candidates[0]!.artifactId;

    const draft = {
      componentType: "sales.calendarHeatmap",
      version: "1.0.0",
      intentName: "sales.calendar_heatmap",
      description: "Display sales as a monthly calendar heatmap",
      paramsJsonSchema: {
        type: "object",
        properties: {
          fiscalYear: { type: "integer", default: 2026 },
          region: { type: "string", enum: ["japan", "north_america", "europe", "apac"] },
        },
      },
      queryTemplate: {
        path: "trend",
        fixedParams: { metric: "revenue", granularity: "month" },
        paramMap: { fiscalYear: "fy", region: "region" },
      },
    };
    const approveRes = await app.request(`/api/kohaku/promotions/${artifactId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft }),
    });
    expect(approveRes.status).toBe(200);

    // The paramsJsonSchema properties are reflected in /catalog's propsSchema.
    const catalog = (await (await app.request("/api/kohaku/catalog")).json()) as {
      components: { type: string; propsSchema?: { properties?: Record<string, unknown> } }[];
    };
    const promoted = catalog.components.find((c) => c.type === "sales.calendarHeatmap");
    expect(promoted?.propsSchema?.properties).toHaveProperty("fiscalYear");
    expect(promoted?.propsSchema?.properties).toHaveProperty("region");

    // Composing the promoted Intent returns a spec with a data.$ref derived from queryTemplate.
    const composeRes = await app.request("/api/kohaku/compose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.calendar_heatmap", params: { fiscalYear: 2026 } } }),
    });
    expect(composeRes.status).toBe(200);
    const { spec } = (await composeRes.json()) as { spec: UISpec };
    const dataNode = spec.components.find((c) => c.data != null);
    expect(dataNode?.data?.$ref).toBe(expectedRef);
  });
});

describe("fixation E2E (L1 -> L0)", () => {
  it("display an L1 view 3 times -> candidate -> fixated -> served with cache:FIXATED thereafter", async () => {
    const dataDir = tmpDir("kohaku-fix-");
    const storage = createFileStoragePort(dataDir);
    const trendDraft = {
      components: [
        {
          id: "root",
          type: "layout.stack",
          props: { direction: "vertical", gap: null },
          children: ["h", "c"],
        },
        { id: "h", type: "text.heading", props: { level: 2, text: "Monthly revenue trend" } },
        {
          id: "c",
          type: "presentChart",
          props: { kind: "line", x: "month", y: "revenue", series: null, stacked: null, title: null },
          children: null,
          data: { $ref: "query://sales/trend?granularity=month&metric=revenue" },
        },
      ],
      events: [],
    };
    const llm = new FakeLlm({ objects: [trendDraft] });
    const { app } = await createApp({ llm, storage, authz: createHmacAuthzPort("s") });

    const body = JSON.stringify({
      intent: { canonical: "sales.trend", params: { metric: "revenue", granularity: "month" } },
    });
    // Compose 3 times (1st is an L1 miss, then hits — each records view.composed)
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/api/kohaku/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(200);
    }

    // Appears as a candidate
    const proposals = (await (await app.request("/api/kohaku/fixations/proposals")).json()) as {
      proposals: { canonical: string; params?: Record<string, unknown>; uses: number }[];
    };
    expect(proposals.proposals).toHaveLength(1);
    expect(proposals.proposals[0]!.canonical).toBe("sales.trend");
    expect(proposals.proposals[0]!.uses).toBe(3);

    // Fixation
    const approveRes = await app.request("/api/kohaku/fixations/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: { canonical: "sales.trend", params: proposals.proposals[0]!.params } }),
    });
    expect(approveRes.status).toBe(200);

    // Thereafter L0 / cache:fixated (neither composer nor LLM is invoked)
    const after = (await (
      await app.request("/api/kohaku/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    ).json()) as { spec: UISpec };
    expect(after.spec.provenance.tier).toBe("L0");
    expect(after.spec.provenance.cache).toBe("fixated");
    expect(after.spec.components.find((c) => c.type === "presentChart")).toBeDefined();
  });
});
