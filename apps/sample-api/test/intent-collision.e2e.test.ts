import { mkdtempSync, writeFileSync } from "node:fs";
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
 * Writes the published snapshot (promotions.json) plus the component.generated (lineage.jsonl) holding html.
 * Used to verify the Intent-name collision guard when startup reconcile restores the projections.
 */
function seedPublished(
  dataDir: string,
  entries: { artifactId: string; componentType: string; intentName: string }[],
): void {
  const promotions: Record<string, unknown> = {};
  const lineageLines: string[] = [];
  for (const e of entries) {
    promotions[e.artifactId] = {
      artifactId: e.artifactId,
      status: "published",
      updatedAt: "2026-07-13T00:00:00.000Z",
      data: {
        draft: {
          componentType: e.componentType,
          version: "1.0.0",
          intentName: e.intentName,
          description: `${e.componentType} test component`,
        },
      },
    };
    lineageLines.push(
      JSON.stringify({
        id: `g-${e.artifactId}`,
        ts: "2026-07-13T00:00:00.000Z",
        actor: { kind: "model" },
        type: "component.generated",
        payload: {
          artifactId: e.artifactId,
          html: "<!DOCTYPE html><html><body><script>window.kohaku.ready()</script></body></html>",
        },
      }),
    );
  }
  writeFileSync(join(dataDir, "promotions.json"), JSON.stringify(promotions, null, 2));
  writeFileSync(join(dataDir, "lineage.jsonl"), lineageLines.join("\n") + "\n");
}

/** Script for sales.custom NL normalization + L2 generation (same shape as promotion.e2e.test.ts). */
const L2_HTML =
  "<!DOCTYPE html><html><head><title>Sales calendar heatmap</title></head><body><div id=hm></div><script>window.kohaku.fetchData('query://sales/trend?fy=2026&granularity=month&metric=revenue').then(function(d){document.getElementById('hm').textContent=d.rows.length;window.kohaku.ready();});</script></body></html>";

// L2 generation uses the generateText (raw HTML) path, so it is not stacked in objects (responds with texts: () => L2_HTML).
function customScripts(): unknown[] {
  return [
    { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } },
    { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } },
  ];
}

/** LLM-as-Judge response on approve (a passing verdict). */
function judgeObject(): unknown {
  return {
    criteria: [
      { id: "safety", score: 0.9, reasoning: "uses kohaku API only" },
      { id: "determinism", score: 0.8, reasoning: "no randomness" },
      { id: "a11y", score: 0.7, reasoning: "has text" },
      { id: "schema_inferability", score: 0.8, reasoning: "parameterizable" },
      { id: "generality", score: 0.8, reasoning: "general-purpose" },
    ],
    summary: "worthy of promotion",
  };
}

async function ask(app: Hono, text: string, sessionId: string): Promise<void> {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { kind: "nl", text }, session: { surface: "chat", sessionId } }),
  });
  expect(res.status).toBe(200);
}

/** Advance to just before publish and obtain the candidate's artifactId. */
async function toCandidate(app: Hono): Promise<string> {
  await ask(app, "Sales as a calendar heatmap", "s1");
  await ask(app, "Sales as a calendar heatmap", "s2");
  const { candidates } = (await (
    await app.request("/api/kohaku/promotions/evaluate", { method: "POST" })
  ).json()) as { candidates: { artifactId: string }[] };
  return candidates[0]!.artifactId;
}

describe("promoted Intent name collision guard", () => {
  it("a promotion whose published snapshot Intent name collides with a core Intent is not reflected by reconcile", async () => {
    const dataDir = tmpDir("kohaku-intent-core-");
    // componentType is unique (no catalog collision) but intentName collides with the core "sales.trend".
    seedPublished(dataDir, [
      { artifactId: "a1", componentType: "sales.trendClone", intentName: "sales.trend" },
    ]);
    const { app } = await createApp({
      llm: new FakeLlm({ objects: [] }),
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("s"),
    });
    const health = (await (await app.request("/api/health")).json()) as {
      promoted: string[];
      intents: string[];
    };
    // The colliding componentType is not adopted, and the core "sales.trend" vocabulary is intact.
    expect(health.promoted).not.toContain("sales.trendClone");
    expect(health.intents).toContain("sales.trend");
  });

  it("promotions with duplicate Intent names across published snapshots are excluded by reconcile rather than last-wins", async () => {
    const dataDir = tmpDir("kohaku-intent-dup-");
    seedPublished(dataDir, [
      { artifactId: "a1", componentType: "sales.alpha", intentName: "sales.shared_intent" },
      { artifactId: "a2", componentType: "sales.beta", intentName: "sales.shared_intent" },
    ]);
    const { app } = await createApp({
      llm: new FakeLlm({ objects: [] }),
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("s"),
    });
    const health = (await (await app.request("/api/health")).json()) as {
      promoted: string[];
      intents: string[];
    };
    // Only the first-arriving a1 is adopted. The duplicate a2 is excluded.
    expect(health.promoted).toEqual(["sales.alpha"]);
    expect(health.intents).toContain("sales.shared_intent");
  });

  it("when draft.intentName collides with a core Intent at approval, publish is rejected and the catalog/Intent stay intact", async () => {
    const dataDir = tmpDir("kohaku-intent-reject-");
    const llm = new FakeLlm({ objects: [...customScripts(), judgeObject()], texts: () => L2_HTML });
    const { app } = await createApp({
      llm,
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("s"),
    });
    const artifactId = await toCandidate(app);

    // componentType is unique but intentName is set to the core "sales.trend" -> publish is rejected.
    const draft = {
      componentType: "sales.calendarHeatmap",
      version: "1.0.0",
      intentName: "sales.trend",
      description: "promotion draft that collides with a core name",
    };
    const approveRes = await app.request(`/api/kohaku/promotions/${artifactId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft }),
    });
    // publish is rejected (not 200).
    expect(approveRes.status).not.toBe(200);

    // validate-then-commit: the promoted component does not appear in the catalog either, and the core Intent is intact.
    const health = (await (await app.request("/api/health")).json()) as {
      promoted: string[];
      intents: string[];
    };
    expect(health.promoted).not.toContain("sales.calendarHeatmap");
    expect(health.intents).toContain("sales.trend");

    const catalog = (await (await app.request("/api/kohaku/catalog")).json()) as {
      components: { type: string }[];
    };
    expect(catalog.components.some((c) => c.type === "sales.calendarHeatmap")).toBe(false);
  });

  it("core Intents remain in the vocabulary even after publish then withdraw", async () => {
    const dataDir = tmpDir("kohaku-intent-withdraw-");
    const llm = new FakeLlm({ objects: [...customScripts(), judgeObject()], texts: () => L2_HTML });
    const { app } = await createApp({
      llm,
      storage: createFileStoragePort(dataDir),
      authz: createHmacAuthzPort("s"),
    });
    const artifactId = await toCandidate(app);
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

    // Record the core Intent set after publish (excluding the promoted one).
    const before = (await (await app.request("/api/health")).json()) as { intents: string[] };
    const coreBefore = before.intents.filter((n) => n !== "sales.calendar_heatmap");
    expect(coreBefore).toContain("sales.trend");

    const withdrawRes = await app.request(`/api/kohaku/promotions/${artifactId}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    expect(withdrawRes.status).toBe(200);

    // The promoted Intent disappears, and all core Intents remain (withdraw does not drag in the core vocabulary).
    const after = (await (await app.request("/api/health")).json()) as { intents: string[] };
    expect(after.intents).not.toContain("sales.calendar_heatmap");
    for (const name of coreBefore) expect(after.intents).toContain(name);
  });
});

describe("DomainPort.invoke unknown operation (A2: prototype pollution guard)", () => {
  async function makeDomain(prefix: string) {
    return (
      await createApp({
        llm: new FakeLlm({ objects: [] }),
        storage: createFileStoragePort(tmpDir(prefix)),
        authz: createHmacAuthzPort("s"),
      })
    ).domain;
  }

  it('op of "toString"/"constructor" does not execute inherited methods and yields an unknown operation error', async () => {
    const domain = await makeDomain("kohaku-proto-");
    await expect(domain.invoke("toString", {}, { principal: { id: "t" } })).rejects.toThrow(
      "unknown operation: toString",
    );
    await expect(domain.invoke("constructor", {}, { principal: { id: "t" } })).rejects.toThrow(
      "unknown operation",
    );
  });

  it("a legitimate operation (summary) resolves normally", async () => {
    const domain = await makeDomain("kohaku-proto-ok-");
    const result = (await domain.invoke("summary", {}, { principal: { id: "t" } })) as UISpec;
    expect(result).toBeDefined();
  });
});
