import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * The promotion-reconcile race: reconcile()'s scan (listPromotionStates) and each candidate's store.load are
 * two separate reads with no lock held across them (host-rest's POST /promotions/reconcile route only holds
 * the tenant-neutral lock bucket, so a tenant-scoped approve/withdraw can run between the two). The fix trusts
 * store.load's freshest read (it re-reads getPromotionState) instead of the value the scan already saw. These
 * tests simulate the race directly: `racingStorage` wraps getPromotionState so it can answer differently from
 * what listPromotionStates already returned for the same artifact, reproducing "the status changed between the
 * scan and the load" without any real concurrency.
 */

function memoryStorage(): StoragePort & {
  events: LineageEventRecord[];
  states: Map<string, PromotionState>;
} {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const key = (id: string, tenant?: string) => `${tenant ?? ""}::${id}`;
  return {
    events,
    states,
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

/**
 * Wraps `base` so `getPromotionState` (the read `store.load` uses inside reconcile) answers with
 * `overrideStatus` for `artifactId`, while `listPromotionStates` (the scan reconcile uses to build its work
 * list) keeps returning `base`'s real, unmodified state. This reproduces "a concurrent transition changed the
 * status between the scan and the load" deterministically, without any real concurrency.
 */
function racingStorage(
  base: StoragePort & { states: Map<string, PromotionState> },
  artifactId: string,
  overrideStatus: PromotionState["status"],
): StoragePort {
  return {
    ...base,
    async getPromotionState(id, tenant) {
      const real = await base.getPromotionState(id, tenant);
      if (real == null || id !== artifactId) return real;
      return { ...real, status: overrideStatus };
    },
  };
}

const draft: ComponentDraft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

const actor = { id: "reviewer-1" };

function seedSchemaProposed(
  storage: StoragePort & { events: LineageEventRecord[] },
  artifactId: string,
): void {
  storage.events.push({
    id: `g-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: "<html>x</html>", request: "r" },
  });
  storage.events.push({
    id: `u-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.used",
    payload: { artifactId, sessionId: "s1" },
  });
  void storage.putPromotionState({
    artifactId,
    status: "schema_proposed",
    updatedAt: new Date().toISOString(),
    data: { draft },
  });
}

describe("reconcile() の走査/load 競合レース(store.load の最新 status を信用して収束する)", () => {
  it("走査後に withdrawn になった published 候補を再公開しない", async () => {
    const storage = memoryStorage();
    seedSchemaProposed(storage, "art-1");
    const seedPromotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async () => {},
    });
    await seedPromotions.act("art-1", { kind: "publish", version: "1.0.0" }, actor);
    expect((await storage.getPromotionState("art-1"))?.status).toBe("published");
    // The synchronous publish already recorded its own component.published event; reconcile must not add a
    // second one for this artifact (that would indicate it treated the stale scan entry as needing a backfill).
    const publishedEventsBefore = storage.events.filter((e) => e.type === "component.published").length;
    expect(publishedEventsBefore).toBe(1);

    // Simulate the race: listPromotionStates (the scan) still returns "published" (base storage, unmodified),
    // but store.load's own read (getPromotionState) now answers "withdrawn" -- as if a tenant-scoped withdraw
    // ran between the scan and this load.
    const racing = racingStorage(storage, "art-1", "withdrawn");
    const applied: string[] = [];
    const removed: string[] = [];
    const errors: unknown[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage: racing }),
      storage: racing,
      onPublish: async ({ artifactId }) => {
        applied.push(artifactId);
      },
      onUnpublish: async ({ artifactId }) => {
        removed.push(artifactId);
      },
      onError: (ctx, e) => errors.push({ ctx, e }),
    });

    const summary = await promotions.reconcile();
    // Not republished (a stale scan entry): reconcile trusts the fresher load, not the scan's own snapshot.
    expect(applied).toEqual([]);
    // Not (incorrectly) unpublished either: the withdrawn branch is driven by listPromotionStates' own status
    // ("published" here, unmodified), so this artifact never enters that branch at all.
    expect(removed).toEqual([]);
    expect(summary).toEqual({ published: 0, withdrawn: 0, skipped: 0 });
    // A stale scan entry is not a failure: no onError, and no component.published audit backfill either
    // (the count stays at the single event the original publish already recorded).
    expect(errors).toEqual([]);
    expect(storage.events.filter((e) => e.type === "component.published")).toHaveLength(1);
  });

  it("走査後に published になった withdrawn 候補を unpublish しない", async () => {
    const storage = memoryStorage();
    seedSchemaProposed(storage, "art-2");
    const seedPromotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async () => {},
      onUnpublish: async () => {},
    });
    await seedPromotions.act("art-2", { kind: "publish", version: "1.0.0" }, actor);
    await seedPromotions.act("art-2", { kind: "unpublish" }, actor);
    expect((await storage.getPromotionState("art-2"))?.status).toBe("withdrawn");
    // The synchronous unpublish already recorded its own component.withdrawn(from:"published") event;
    // reconcile must not add a second one for this artifact.
    const withdrawnEventsBefore = storage.events.filter(
      (e) => e.type === "component.withdrawn" && e.payload["from"] === "published",
    ).length;
    expect(withdrawnEventsBefore).toBe(1);

    // Simulate the reverse race: listPromotionStates still returns "withdrawn" (unmodified), but store.load's
    // own read now answers "published" -- as if a tenant-scoped re-approve/publish ran between the scan and
    // this load.
    const racing = racingStorage(storage, "art-2", "published");
    const applied: string[] = [];
    const removed: string[] = [];
    const errors: unknown[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage: racing }),
      storage: racing,
      onPublish: async ({ artifactId }) => {
        applied.push(artifactId);
      },
      onUnpublish: async ({ artifactId }) => {
        removed.push(artifactId);
      },
      onError: (ctx, e) => errors.push({ ctx, e }),
    });

    const summary = await promotions.reconcile();
    // Not unpublished (a stale scan entry).
    expect(removed).toEqual([]);
    // Not republished either: the published branch is driven by listPromotionStates' own status ("withdrawn"
    // here, unmodified), so this artifact never enters that branch at all.
    expect(applied).toEqual([]);
    expect(summary).toEqual({ published: 0, withdrawn: 0, skipped: 0 });
    expect(errors).toEqual([]);
    // No new backfill event either (the count stays at the single event the original unpublish already recorded).
    expect(
      storage.events.filter((e) => e.type === "component.withdrawn" && e.payload["from"] === "published"),
    ).toHaveLength(1);
  });
});

describe("reconcile() は published / withdrawn 以外のスナップショットを完全に無視する(mayHaveProjection)", () => {
  it.each(["schema_proposed", "approved", "rejected", "changes_requested", "judge_failed"] as const)(
    "status=%s の候補には onPublish/onUnpublish を呼ばず、skipped にも数えず、監査イベントも出さない",
    async (status) => {
      const storage = memoryStorage();
      await storage.putPromotionState({
        artifactId: `art-${status}`,
        status,
        updatedAt: new Date().toISOString(),
        data: { draft },
      });
      const removed: string[] = [];
      const applied: string[] = [];
      const errors: unknown[] = [];
      const promotions = createPromotions({
        lineage: createLineage({ storage }),
        storage,
        onPublish: async ({ artifactId }) => {
          applied.push(artifactId);
        },
        onUnpublish: async ({ artifactId }) => {
          removed.push(artifactId);
        },
        onError: (ctx, e) => errors.push({ ctx, e }),
      });

      const summary = await promotions.reconcile();
      expect(removed).toEqual([]);
      expect(applied).toEqual([]);
      expect(summary).toEqual({ published: 0, withdrawn: 0, skipped: 0 });
      expect(errors).toEqual([]);
      expect(storage.events.some((e) => e.type === "component.withdrawn")).toBe(false);
      expect(storage.events.some((e) => e.type === "component.published")).toBe(false);
    },
  );
});
