import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComponentDraft, createLineage, createPromotions } from "@kohaku-ui/lineage";
import type { LineageEventRecord, Principal } from "@kohaku-ui/spec-core";
import { afterAll, describe, expect, it } from "vitest";
import { createFileStoragePort } from "../src/ports/storage-port.js";

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
 * Verifies tenant isolation of promotion state against the real behavior of FileStoragePort.
 * Since this is a persistence test, it uses a mkdtemp temporary directory (the AGENTS.md convention).
 */
function freshStorage() {
  return createFileStoragePort(tmpDir("kohaku-promo-tenant-"));
}

function generatedEvent(artifactId: string, tenant?: string): LineageEventRecord {
  return {
    id: `g-${tenant ?? "none"}-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: "<html></html>", request: "r" },
    ...(tenant != null ? { tenant } : {}),
  };
}

describe("FileStoragePort: promotion state tenant isolation", () => {
  const now = () => new Date().toISOString();

  it("putPromotionState/getPromotionState keys are separated by (tenant, artifactId)", async () => {
    const storage = freshStorage();
    await storage.putPromotionState({
      artifactId: "a1",
      status: "candidate",
      updatedAt: now(),
      data: {},
      tenant: "acme",
    });
    await storage.putPromotionState({
      artifactId: "a1",
      status: "published",
      updatedAt: now(),
      data: {},
      tenant: "globex",
    });

    // Even with the same artifactId, returns independent state per tenant (no cross-talk).
    expect((await storage.getPromotionState("a1", "acme"))?.status).toBe("candidate");
    expect((await storage.getPromotionState("a1", "globex"))?.status).toBe("published");
    // No tenant specified means the legacy key (artifactId only). Tenant-scoped state is not visible.
    expect(await storage.getPromotionState("a1")).toBeNull();
  });

  it("listPromotionStates(tenant) returns only that tenant's entries; unspecified returns all (including legacy)", async () => {
    const storage = freshStorage();
    await storage.putPromotionState({
      artifactId: "a1",
      status: "candidate",
      updatedAt: now(),
      data: {},
      tenant: "acme",
    });
    await storage.putPromotionState({
      artifactId: "b1",
      status: "published",
      updatedAt: now(),
      data: {},
      tenant: "globex",
    });
    // legacy (no tenant) state.
    await storage.putPromotionState({ artifactId: "c1", status: "in_review", updatedAt: now(), data: {} });

    expect((await storage.listPromotionStates("acme")).map((s) => s.artifactId)).toEqual(["a1"]);
    expect((await storage.listPromotionStates("globex")).map((s) => s.artifactId)).toEqual(["b1"]);
    expect((await storage.listPromotionStates()).map((s) => s.artifactId).sort()).toEqual(["a1", "b1", "c1"]);
  });

  it("legacy (tenant-less) state is tenant-neutral: retrievable only when tenant is unspecified", async () => {
    const storage = freshStorage();
    // Write the equivalent of the old format (no tenant field).
    await storage.putPromotionState({ artifactId: "a1", status: "approved", updatedAt: now(), data: {} });
    expect((await storage.getPromotionState("a1"))?.status).toBe("approved");
    // Not visible from a tenant scope because it is a separate key (isolation, not fail-open).
    expect(await storage.getPromotionState("a1", "acme")).toBeNull();
  });

  it("via createPromotions: promoting the same artifactId in both tenants does not cross-contaminate and survives reload", async () => {
    const dir = tmpDir("kohaku-promo-tenant-e2e-");
    const storage = createFileStoragePort(dir);
    const reviewer: Principal = { id: "admin" };
    const draft: ComponentDraft = {
      componentType: "sales.customX",
      version: "1.0.0",
      intentName: "sales.customX",
      description: "test draft",
    };
    // acme / globex each generate the same artifactId "a1" (belonging to different tenants).
    await storage.appendLineage(generatedEvent("a1", "acme"));
    await storage.appendLineage(generatedEvent("a1", "globex"));
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      // With no judge specified + judgeBlocking:false, approve passes through to published.
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });

    // acme approves, globex rejects.
    expect((await promotions.approve("a1", draft, reviewer, { tenant: "acme" })).status).toBe("published");
    // globex is still unaffected by acme's approval and is in_use.
    expect((await promotions.get("a1", { tenant: "globex" }))?.status).toBe("in_use");
    expect((await promotions.reject("a1", reviewer, { tenant: "globex" })).status).toBe("rejected");
    // acme is not affected by globex's rejection.
    expect((await promotions.get("a1", { tenant: "acme" }))?.status).toBe("published");

    // Even on a reload equivalent to a separate process, state stays isolated by (tenant, artifactId) (round-trip of the persistence key).
    const reloaded = createFileStoragePort(dir);
    expect((await reloaded.getPromotionState("a1", "acme"))?.status).toBe("published");
    expect((await reloaded.getPromotionState("a1", "globex"))?.status).toBe("rejected");
  });
});
