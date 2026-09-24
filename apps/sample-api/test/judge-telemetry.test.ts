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

/**
 * B7 Pillar 2: wiring verification for integrating runtime telemetry into review.
 * Confirms, via FakeLlm's call records, that the actual-render observations recorded through /telemetry
 * (component.used with source:"telemetry") are received by the LLM-as-Judge on the approve path as prompt evidence.
 */
const L2_HTML =
  "<!DOCTYPE html><html><head><title>Sales calendar heatmap</title></head><body><div id=hm></div><script>window.kohaku.fetchData('query://sales/trend?fy=2026&granularity=month&metric=revenue').then(function(d){document.getElementById('hm').textContent=d.rows.length+' months';window.kohaku.ready();});</script></body></html>";

// L2 now uses the generateText (raw HTML) path, so only the normalized Intent is stacked in objects,
// and the L2 response is separated onto the texts side (L2_HTML).
function customScripts(): unknown[] {
  return [
    { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } },
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

describe("runtime telemetry integration into promotion review (B7 Pillar 2)", () => {
  it("/telemetry actual-render observations are transcribed into the judge prompt and the verdict records the rubric version", async () => {
    const dataDir = tmpDir("kohaku-judge-tel-");
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
      texts: [L2_HTML],
    });
    const { app } = await createApp({ llm, storage, authz });

    // Use twice -> nominate.
    await ask(app, "Sales as a calendar heatmap", "s1");
    await ask(app, "Sales as a calendar heatmap", "s2");
    const { candidates } = (await (
      await app.request("/api/kohaku/promotions/evaluate", { method: "POST" })
    ).json()) as { candidates: { artifactId: string }[] };
    const artifactId = candidates[0]!.artifactId;

    // Actual-render telemetry: record 2 observations (1 of which is an error).
    const telRes = await app.request("/api/kohaku/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { kind: "componentUsed", artifactId, outcome: "ok", sessionId: "s1" },
          { kind: "componentUsed", artifactId, outcome: "error", sessionId: "s2" },
        ],
      }),
    });
    expect(telRes.status).toBe(200);

    // Approve -> judge runs.
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

    // The actual-render observations are transcribed into the judge's prompt (rendered=2, errors=1).
    const judgeCall = llm.calls.find((c) => c.system?.includes("promotion reviewer"));
    expect(judgeCall).toBeDefined();
    expect(judgeCall!.prompt).toContain("Runtime telemetry");
    expect(judgeCall!.prompt).toContain("rendered=2, errors=1");

    // component.judged's verdict has rubricId / rubricVersion stamped (Pillar 3).
    const lineageRes = await app.request(`/api/kohaku/lineage?artifactId=${artifactId}&limit=50`);
    const { events } = (await lineageRes.json()) as {
      events: { type: string; payload: Record<string, unknown> }[];
    };
    const judged = events.find((e) => e.type === "component.judged");
    const verdict = judged!.payload["verdict"] as Record<string, unknown>;
    expect(verdict["rubricId"]).toBe("l2-promotion");
    expect(verdict["rubricVersion"]).toBe("0.4");
  });
});

/** A function script that branches on schemaName (independent of compose cache presence / call count). */
function multiTenantScript(req: { schemaName?: string }): unknown {
  switch (req.schemaName) {
    case "canonical_intent":
      return { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } };
    case "judge_verdict":
      return {
        criteria: [
          { id: "safety", score: 0.9, reasoning: "uses kohaku API only" },
          { id: "determinism", score: 0.8, reasoning: "no randomness" },
          { id: "a11y", score: 0.7, reasoning: "has text" },
          { id: "schema_inferability", score: 0.8, reasoning: "parameterizable" },
          { id: "generality", score: 0.8, reasoning: "general-purpose" },
          { id: "suggestion_fidelity", score: 1, reasoning: "no proposal" },
        ],
        summary: "worthy of promotion",
      };
    default:
      throw new Error(`unexpected schemaName: ${req.schemaName}`);
  }
}

async function askTenant(app: Hono, tenant: string, sessionId: string): Promise<void> {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json", "x-kohaku-tenant": tenant },
    body: JSON.stringify({
      input: { kind: "nl", text: "Sales as a calendar heatmap" },
      session: { surface: "chat", sessionId },
    }),
  });
  expect(res.status).toBe(200);
}

async function evaluateTenant(app: Hono, tenant: string): Promise<string> {
  const res = await app.request("/api/kohaku/promotions/evaluate", {
    method: "POST",
    headers: { "x-kohaku-tenant": tenant },
  });
  const { candidates } = (await res.json()) as { candidates: { artifactId: string }[] };
  return candidates[0]!.artifactId;
}

async function recordTelemetry(
  app: Hono,
  tenant: string,
  artifactId: string,
  events: { outcome: "ok" | "error"; sessionId: string }[],
): Promise<void> {
  const res = await app.request("/api/kohaku/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json", "x-kohaku-tenant": tenant },
    body: JSON.stringify({
      events: events.map((e) => ({
        kind: "componentUsed",
        artifactId,
        outcome: e.outcome,
        sessionId: e.sessionId,
      })),
    }),
  });
  expect(res.status).toBe(200);
}

/**
 * Tenant isolation of promotion-review telemetry (fix F1-1). Two tenants use the same artifactId
 * (derived from content sha256, unique across tenants), and this verifies that one tenant's actual-render
 * telemetry does not leak into the other's judge input on approve.
 */
describe("promotion review telemetry tenant isolation (F1-1)", () => {
  it("even when the same artifactId is used in two tenants, the judge at approve time carries only that tenant's telemetry", async () => {
    const dataDir = tmpDir("kohaku-judge-tel-multi-");
    const storage = createFileStoragePort(dataDir);
    const authz = createHmacAuthzPort("test-secret");
    // L2 (raw HTML generation) uses the generateText path, so it responds with a function script on the texts side.
    const llm = new FakeLlm({ objects: multiTenantScript, texts: () => L2_HTML });
    const { app } = await createApp({ llm, storage, authz });

    // acme / globex each compose twice with the same request (yielding the same artifactId).
    await askTenant(app, "acme", "a1");
    await askTenant(app, "acme", "a2");
    await askTenant(app, "globex", "g1");
    await askTenant(app, "globex", "g2");

    // The same artifactId is nominated in both tenants (belonging to different tenants).
    const artifactId = await evaluateTenant(app, "acme");
    expect(await evaluateTenant(app, "globex")).toBe(artifactId);

    // Actual-render telemetry: acme has 1 observation (ok), globex has 3 observations (2 of which are errors).
    await recordTelemetry(app, "acme", artifactId, [{ outcome: "ok", sessionId: "a1" }]);
    await recordTelemetry(app, "globex", artifactId, [
      { outcome: "error", sessionId: "g1" },
      { outcome: "error", sessionId: "g2" },
      { outcome: "ok", sessionId: "g1" },
    ]);

    // Approve acme -> judge runs.
    const draft = {
      componentType: "sales.calendarHeatmap",
      version: "1.0.0",
      intentName: "sales.calendar_heatmap",
      description: "Display sales as a monthly calendar heatmap",
    };
    const approveRes = await app.request(`/api/kohaku/promotions/${artifactId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kohaku-tenant": "acme" },
      body: JSON.stringify({ draft }),
    });
    expect(approveRes.status).toBe(200);

    // The judge prompt carries only acme's telemetry (rendered=1, errors=0).
    const judgeCall = llm.calls.find((c) => c.system?.includes("promotion reviewer"));
    expect(judgeCall).toBeDefined();
    expect(judgeCall!.prompt).toContain("rendered=1, errors=0");
    // Neither globex's telemetry (rendered=3, errors=2) nor the combined total (rendered=4, errors=2) leaks in.
    expect(judgeCall!.prompt).not.toContain("rendered=3");
    expect(judgeCall!.prompt).not.toContain("rendered=4");
    expect(judgeCall!.prompt).not.toContain("errors=2");
  });
});
