import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createLineage, createPromotions } from "../src/index.js";

/**
 * nominate's idempotency guard (nomination.ts) must be keyed by (tenant, artifactId), not artifactId alone
 * (#10, mirroring candidate-store.ts's own composite key), and its component.nominated audit record must be
 * fail-open like handlePublish's own audit record (a storage hiccup recording the audit must not stop the rest
 * of the nominate batch, nor undo the already-persisted status transition).
 */

function memoryStorage(): StoragePort & { events: LineageEventRecord[]; failAppendFor: Set<string> } {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const key = (id: string, tenant?: string) => `${tenant ?? ""}::${id}`;
  const failAppendFor = new Set<string>();
  return {
    events,
    failAppendFor,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
      if (failAppendFor.has(event.type)) throw new Error(`appendLineage failed for ${event.type} (test)`);
      events.push(event);
    },
    async listLineage(filter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      if (filter.tenant != null) result = result.filter((e) => e.tenant === filter.tenant);
      if (filter.artifactId != null)
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
      return result.slice(-(filter.limit ?? 200));
    },
    async getPromotionState(id, tenant) {
      return states.get(key(id, tenant)) ?? null;
    },
    async putPromotionState(state) {
      states.set(key(state.artifactId, state.tenant), state);
    },
    async listPromotionStates(tenant) {
      const all = [...states.values()];
      return tenant != null ? all.filter((s) => s.tenant === tenant) : all;
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

function seedGenerated(
  storage: StoragePort & { events: LineageEventRecord[] },
  artifactId: string,
  tenant: string | undefined,
): void {
  storage.events.push({
    id: `g-${artifactId}-${tenant ?? ""}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: `<html>${artifactId}</html>`, request: "r" },
    ...(tenant != null ? { tenant } : {}),
  });
}

function seedUsage(
  storage: StoragePort & { events: LineageEventRecord[] },
  artifactId: string,
  tenant: string | undefined,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    storage.events.push({
      id: `u-${artifactId}-${tenant ?? ""}-${i}`,
      ts: new Date().toISOString(),
      actor: { kind: "user" },
      type: "component.used",
      payload: { artifactId, sessionId: "s1" },
      ...(tenant != null ? { tenant } : {}),
    });
  }
}

function seedNominated(
  storage: StoragePort & { events: LineageEventRecord[] },
  artifactId: string,
  tenant: string | undefined,
): void {
  storage.events.push({
    id: `n-${artifactId}-${tenant ?? ""}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.nominated",
    payload: { artifactId, by: "policy" },
    ...(tenant != null ? { tenant } : {}),
  });
}

const policy = { minUses: 1, minDistinctSessions: 1, judgeBlocking: false };

describe("nominate の冪等ガードは (tenant, artifactId) の複合キー", () => {
  it("tenant t1 の過去 nominate はテナント中立の同一 artifactId の nominate を抑止しない", async () => {
    const storage = memoryStorage();
    // t1 already nominated "shared-z" in the past (a component.nominated event with tenant:"t1").
    seedNominated(storage, "shared-z", "t1");
    // A tenant-neutral candidate for the *same* globally-unique artifactId, independently eligible.
    seedGenerated(storage, "shared-z", undefined);
    seedUsage(storage, "shared-z", undefined, 3);

    const promotions = createPromotions({ lineage: createLineage({ storage }), storage, policy });

    // Before the fix, nominatedIds was keyed by artifactId alone: an all-tenant scan (tenant unspecified) would
    // pull t1's component.nominated event into the same Set as the tenant-neutral candidate's own check,
    // silently suppressing this eligible in_use candidate forever.
    const candidates = await promotions.evaluateAndList();
    const neutral = candidates.find((c) => c.artifactId === "shared-z");
    expect(neutral?.status).toBe("candidate");
    expect((await storage.getPromotionState("shared-z", undefined))?.status).toBe("candidate");
  });

  it("tenant t1 の過去 nominate は同じ tenant t1 の再評価では引き続き抑止する(退行防止)", async () => {
    const storage = memoryStorage();
    seedNominated(storage, "shared-w", "t1");
    seedGenerated(storage, "shared-w", "t1");
    seedUsage(storage, "shared-w", "t1", 3);

    const promotions = createPromotions({ lineage: createLineage({ storage }), storage, policy });

    // t1's own re-evaluation must still treat "shared-w" as already nominated (no duplicate component.nominated
    // record), even though no promotion state was ever persisted for it in this test (a pre-existing nominate
    // that predates this test's own storage snapshot -- the idempotency guard is event-log-driven, per
    // nomination.ts's own doc, precisely so GET-style repeated calls don't double-record).
    await promotions.evaluateAndList({ tenant: "t1" });
    const nominatedEvents = (
      await storage.listLineage({ type: ["component.nominated"], tenant: "t1" })
    ).filter((e) => e.payload["artifactId"] === "shared-w");
    expect(nominatedEvents).toHaveLength(1);
  });
});

describe("nominate の component.nominated 監査記録は fail-open", () => {
  it("1 件の監査記録が失敗しても後続候補は nominate され、失敗はそれぞれ onError(promotion.nominate.audit) に届く", async () => {
    const storage = memoryStorage();
    seedGenerated(storage, "art-a", undefined);
    seedUsage(storage, "art-a", undefined, 3);
    seedGenerated(storage, "art-b", undefined);
    seedUsage(storage, "art-b", undefined, 3);
    storage.failAppendFor.add("component.nominated");

    const errors: { endpoint: string; artifactId: string }[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy,
      onError: (ctx) => errors.push({ endpoint: ctx.endpoint, artifactId: ctx.artifactId }),
    });

    const candidates = await promotions.evaluateAndList();
    // The status transition (persistMany) already ran before the audit loop, so both candidates are
    // "candidate" regardless of the audit failure -- the fail-open contract this mirrors from handlePublish.
    expect(candidates.find((c) => c.artifactId === "art-a")?.status).toBe("candidate");
    expect(candidates.find((c) => c.artifactId === "art-b")?.status).toBe("candidate");
    expect((await storage.getPromotionState("art-a", undefined))?.status).toBe("candidate");
    expect((await storage.getPromotionState("art-b", undefined))?.status).toBe("candidate");
    // Both failures are individually reported (the throw for art-a's own record must not stop art-b's).
    expect(errors).toContainEqual({ endpoint: "promotion.nominate.audit", artifactId: "art-a" });
    expect(errors).toContainEqual({ endpoint: "promotion.nominate.audit", artifactId: "art-b" });
    expect(errors).toHaveLength(2);
    expect(storage.events.some((e) => e.type === "component.nominated")).toBe(false);
  });

  it("監査記録が復旧すれば通常どおり記録される(fail-open は恒久的な握りつぶしではない)", async () => {
    const storage = memoryStorage();
    seedGenerated(storage, "art-c", undefined);
    seedUsage(storage, "art-c", undefined, 3);

    const errors: unknown[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy,
      onError: (ctx) => errors.push(ctx),
    });

    const candidates = await promotions.evaluateAndList();
    expect(candidates.find((c) => c.artifactId === "art-c")?.status).toBe("candidate");
    expect(storage.events.some((e) => e.type === "component.nominated")).toBe(true);
    expect(errors).toHaveLength(0);
  });
});
