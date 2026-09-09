import type { LineageEventRecord, Principal, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createLineage, createPromotions } from "../src/index.js";

/**
 * #10: tenant-unspecified scans (scanCandidates / listByStatus / evaluateAndList) must not mix tenants together.
 * artifactId derives from content sha256 and is globally unique, so the *same* artifactId can legitimately be
 * promoted independently by multiple tenants — an all-tenant scan (tenant left unspecified, e.g. a host with no
 * `deps.tenant` narrowing, or an operator survey across tenants) must keep each tenant's state/usage separate
 * rather than collapsing them into one candidate or aggregating their usage together.
 */

function memoryStorage(): StoragePort & { events: LineageEventRecord[] } {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const key = (id: string, tenant?: string) => `${tenant ?? ""}::${id}`;
  return {
    events,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
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

/** Seeds `count` component.used events (same session, non-telemetry) for the given (artifactId, tenant). */
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

const reviewer: Principal = { id: "reviewer-1" };

describe("#10 テナント伝播: listByStatus はレコード自身の tenant で解決する", () => {
  it("tenant 未指定の listByStatus(candidate) は各状態を state.tenant で読み直し、status が化けない", async () => {
    const storage = memoryStorage();
    // The same globally-unique artifactId, generated independently by two tenants.
    seedGenerated(storage, "shared-x", "acme");
    seedGenerated(storage, "shared-x", "globex");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await promotions.act("shared-x", { kind: "nominate", by: reviewer }, reviewer, { tenant: "acme" });
    expect((await storage.getPromotionState("shared-x", "acme"))?.status).toBe("candidate");
    // globex's copy was never nominated (still in_use, no persisted state at all).
    expect(await storage.getPromotionState("shared-x", "globex")).toBeNull();

    // Scanning across all tenants (tenant unspecified) for status "candidate" must find exactly acme's entry and
    // report its real status. Before #10, listByStatus called loadCandidate with the call-level (unspecified)
    // tenant instead of each state's own tenant, so getPromotionState("shared-x", undefined) missed the
    // tenant-keyed state entirely and the returned candidate's status silently reverted to "in_use".
    const candidates = await promotions.listByStatus("candidate");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.status).toBe("candidate");
  });
});

describe("#10 テナント伝播: list()(scan) は (tenant, artifactId) 単位で候補を分離する", () => {
  it("同一 artifactId を複数テナントが独立に生成しても、使用回数は合算されず候補も1つに潰れない", async () => {
    const storage = memoryStorage();
    seedGenerated(storage, "shared-y", "acme");
    seedGenerated(storage, "shared-y", "globex");
    seedUsage(storage, "shared-y", "acme", 3);
    seedUsage(storage, "shared-y", "globex", 1);
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    // Before #10, scanCandidates deduped by artifactId alone, so an all-tenant scan of "shared-y" collapsed to a
    // single candidate whose usage was drawn from a plain-artifactId index (all tenants' component.used merged).
    const candidates = (await promotions.list()).filter((c) => c.artifactId === "shared-y");
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.uses).sort()).toEqual([1, 3]);
  });
});

describe("#10 evaluateAndList: tenant 未指定かつ tenant 付き候補が混在する場合は persist をスキップする", () => {
  it("tenant 付き候補は候補化されず onError(promotion.nominate.tenant) に通知される。tenant 無しレコードは通常どおり候補化される", async () => {
    const storage = memoryStorage();
    seedGenerated(storage, "acme-art", "acme");
    seedUsage(storage, "acme-art", "acme", 3);
    seedGenerated(storage, "neutral-art", undefined);
    seedUsage(storage, "neutral-art", undefined, 3);

    const errors: { endpoint: string; artifactId: string; tenant?: string }[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
      onError: (ctx) =>
        errors.push({ endpoint: ctx.endpoint, artifactId: ctx.artifactId, tenant: ctx.tenant }),
    });

    // Single-tenant operation (a host with no tenant resolution at all) always calls evaluateAndList with no
    // scope, so this must remain the common case that is entirely unaffected by the guard below.
    const candidates = await promotions.evaluateAndList();
    const acme = candidates.find((c) => c.artifactId === "acme-art");
    const neutral = candidates.find((c) => c.artifactId === "neutral-art");
    expect(neutral?.status).toBe("candidate");
    // The tenant-tagged candidate is left in_use (skipped) rather than persisted under a tenant-neutral state
    // that would shadow/pollute tenant "acme"'s own governance state.
    expect(acme?.status).toBe("in_use");
    expect(await storage.getPromotionState("acme-art", "acme")).toBeNull();
    expect(await storage.getPromotionState("acme-art", undefined)).toBeNull();
    expect(errors).toEqual([
      { endpoint: "promotion.nominate.tenant", artifactId: "acme-art", tenant: "acme" },
    ]);
  });

  it("tenant を明示した evaluateAndList(その tenant のレコードのみを走査)は通常どおり候補化する(単一テナント運用は無影響)", async () => {
    const storage = memoryStorage();
    seedGenerated(storage, "acme-art", "acme");
    seedUsage(storage, "acme-art", "acme", 3);

    const errors: unknown[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
      onError: (ctx) => errors.push(ctx),
    });

    const candidates = await promotions.evaluateAndList({ tenant: "acme" });
    expect(candidates.find((c) => c.artifactId === "acme-art")?.status).toBe("candidate");
    expect((await storage.getPromotionState("acme-art", "acme"))?.status).toBe("candidate");
    expect(errors).toHaveLength(0);
  });
});
