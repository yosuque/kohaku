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

// #1: promotion publishing is isolated per tenant. Tenant A's approval is reflected only in A's catalog / Intent,
// and does not appear in B's. B can independently approve the same artifact and is not ignored by an artifactId-only idempotency check.

const L2_HTML =
  "<!DOCTYPE html><html><body><div id=hm></div><script>window.kohaku.fetchData('query://sales/trend?fy=2026&granularity=month&metric=revenue').then(function(d){document.getElementById('hm').textContent=d.rows.length;window.kohaku.ready();});</script></body></html>";

/** One tenant's "NL -> sales.custom -> L2 generation" + judge response script. */
function tenantScripts(): unknown[] {
  return [
    { intent: "sales.custom", params: { request: "Sales as a calendar heatmap" } },
    // L2 generation uses the generateText (raw HTML) path, so it is not stacked in objects (responds on the texts side).
    {
      criteria: [
        { id: "safety", score: 0.9, reasoning: "kohaku API only" },
        { id: "determinism", score: 0.8, reasoning: "no randomness" },
        { id: "a11y", score: 0.7, reasoning: "has text" },
        { id: "schema_inferability", score: 0.8, reasoning: "parameterizable" },
        { id: "generality", score: 0.8, reasoning: "general-purpose" },
      ],
      summary: "worthy of promotion",
    },
  ];
}

const DRAFT = {
  componentType: "sales.calendarHeatmap",
  version: "1.0.0",
  intentName: "sales.calendar_heatmap",
  description: "Display sales as a monthly calendar heatmap",
};

function tenantHeaders(tenant?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(tenant != null ? { "x-kohaku-tenant": tenant } : {}),
  };
}

async function ask(app: Hono, text: string, sessionId: string, tenant?: string): Promise<UISpec> {
  const res = await app.request("/api/kohaku/compose", {
    method: "POST",
    headers: tenantHeaders(tenant),
    body: JSON.stringify({ input: { kind: "nl", text }, session: { surface: "chat", sessionId } }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { spec: UISpec }).spec;
}

/** Use L2 twice for the given tenant -> nominate -> approve (publish), and return the artifactId. */
async function promoteAs(app: Hono, tenant?: string): Promise<string> {
  await ask(app, "Sales as a calendar heatmap", "s1", tenant);
  await ask(app, "Sales as a calendar heatmap", "s2", tenant);
  const evalRes = await app.request("/api/kohaku/promotions/evaluate", {
    method: "POST",
    headers: tenantHeaders(tenant),
  });
  const { candidates } = (await evalRes.json()) as { candidates: { artifactId: string }[] };
  expect(candidates).toHaveLength(1);
  const artifactId = candidates[0]!.artifactId;
  const approveRes = await app.request(`/api/kohaku/promotions/${artifactId}/approve`, {
    method: "POST",
    headers: tenantHeaders(tenant),
    body: JSON.stringify({ draft: DRAFT }),
  });
  expect(approveRes.status).toBe(200);
  return artifactId;
}

async function health(app: Hono, tenant?: string): Promise<{ promoted: string[]; intents: string[] }> {
  const res = await app.request("/api/health", { headers: tenantHeaders(tenant) });
  return (await res.json()) as { promoted: string[]; intents: string[] };
}

async function catalogTypes(app: Hono, tenant?: string): Promise<string[]> {
  const res = await app.request("/api/kohaku/catalog", { headers: tenantHeaders(tenant) });
  const { components } = (await res.json()) as { components: { type: string }[] };
  return components.map((c) => c.type);
}

function makeApp(dataDir: string) {
  // Prepare one set of L2 generation + judge per tenant (2 sets for A and B).
  const llm = new FakeLlm({ objects: [...tenantScripts(), ...tenantScripts()], texts: () => L2_HTML });
  return createApp({ llm, storage: createFileStoragePort(dataDir), authz: createHmacAuthzPort("s") });
}

describe("promotion publish tenant isolation", () => {
  it("tenant A's approval appears only in A's catalog / Intent, not in B", async () => {
    const dataDir = tmpDir("kohaku-tenant-iso-");
    const { app } = await makeApp(dataDir);

    await promoteAs(app, "tenant-a");

    // The promoted component appears in A's catalog / Intent.
    expect(await catalogTypes(app, "tenant-a")).toContain("sales.calendarHeatmap");
    expect((await health(app, "tenant-a")).intents).toContain("sales.calendar_heatmap");

    // It does not appear in B's catalog / Intent (tenant boundary).
    expect(await catalogTypes(app, "tenant-b")).not.toContain("sales.calendarHeatmap");
    expect((await health(app, "tenant-b")).intents).not.toContain("sales.calendar_heatmap");
  });

  it("tenant B can independently approve the same artifact (not ignored by artifactId-only idempotency)", async () => {
    const dataDir = tmpDir("kohaku-tenant-iso2-");
    const { app } = await makeApp(dataDir);

    const idA = await promoteAs(app, "tenant-a");
    const idB = await promoteAs(app, "tenant-b");
    // Same content -> same artifactId (derived from content sha256, unique across tenants).
    expect(idB).toBe(idA);

    // Even so, it is published independently on the B side (not suppressed by global idempotency).
    expect(await catalogTypes(app, "tenant-b")).toContain("sales.calendarHeatmap");
    expect((await health(app, "tenant-b")).intents).toContain("sales.calendar_heatmap");
  });
});
