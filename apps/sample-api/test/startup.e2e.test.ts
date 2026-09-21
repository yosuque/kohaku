import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import type { ComponentDraft } from "@kohaku-ui/lineage";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
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

// Startup reconcile: the promotion-state snapshot (promotions.json) is the single source of truth for state,
// and createApp scans it and rebuilds the projections (catalog / Intent) via idempotent re-application of onPublish.
// promoted.json is no longer authoritative (it is derived from the snapshot + component.generated).

function draft(componentType: string, intentName: string): ComponentDraft {
  return { componentType, version: "1.0.0", intentName, description: `${componentType} test component` };
}

/**
 * Writes the published snapshot (promotions.json) plus the component.generated (lineage.jsonl) holding its html
 * directly into dataDir. Verifies that createApp's reconcile restores the projections from these.
 */
function seedPublished(
  dataDir: string,
  entries: { artifactId: string; componentType: string; intentName: string }[],
): void {
  const promotions: Record<string, unknown> = {};
  const lineageLines: string[] = [];
  for (const e of entries) {
    // No tenant specified -> the promotions.json key is the artifactId itself (single-tenant compatible).
    promotions[e.artifactId] = {
      artifactId: e.artifactId,
      status: "published",
      updatedAt: "2026-07-13T00:00:00.000Z",
      data: { draft: draft(e.componentType, e.intentName) },
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
          request: "r",
        },
      }),
    );
  }
  writeFileSync(join(dataDir, "promotions.json"), JSON.stringify(promotions, null, 2));
  writeFileSync(join(dataDir, "lineage.jsonl"), lineageLines.join("\n") + "\n");
}

async function healthOf(dataDir: string): Promise<{ promoted: string[]; intents: string[] }> {
  const { app } = await createApp({
    llm: new FakeLlm({ objects: [] }),
    storage: createFileStoragePort(dataDir),
    authz: createHmacAuthzPort("s"),
  });
  return (await (await app.request("/api/health")).json()) as { promoted: string[]; intents: string[] };
}

describe("startup reconcile (snapshot authority to projection)", () => {
  it("promoted parts / Intents are restored to the projection from published snapshots", async () => {
    const dataDir = tmpDir("kohaku-reconcile-");
    seedPublished(dataDir, [
      { artifactId: "a1", componentType: "sales.alpha", intentName: "sales.alpha_intent" },
      { artifactId: "a2", componentType: "sales.beta", intentName: "sales.beta_intent" },
    ]);

    const health = await healthOf(dataDir);
    expect(health.promoted).toEqual(expect.arrayContaining(["sales.alpha", "sales.beta"]));
    expect(health.intents).toEqual(expect.arrayContaining(["sales.alpha_intent", "sales.beta_intent"]));
  });

  it("a published snapshot with a colliding componentType reflects only one into the projection, first-wins (reconcile hardening)", async () => {
    const dataDir = tmpDir("kohaku-reconcile-conflict-");
    seedPublished(dataDir, [
      { artifactId: "a1", componentType: "sales.dup", intentName: "sales.dup_one" },
      { artifactId: "a2", componentType: "sales.dup", intentName: "sales.dup_two" },
    ]);

    const health = await healthOf(dataDir);
    // The second entry with a colliding componentType is skipped by registry.publish's validate-then-commit.
    expect(health.promoted).toEqual(["sales.dup"]);
    expect(health.intents).toContain("sales.dup_one");
    expect(health.intents).not.toContain("sales.dup_two");
  });

  it("starts with zero promotions when there is no snapshot", async () => {
    const dataDir = tmpDir("kohaku-reconcile-empty-");
    const health = await healthOf(dataDir);
    expect(health.promoted).toEqual([]);
  });
});
