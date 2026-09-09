import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * #9: self-contained published projection. Once published, `persist` duplicates html/sha256/ref/componentType
 * onto the snapshot's own `data` (candidate-store.ts). This test proves the point of that duplication: even if
 * lineage.jsonl (and hence the `component.generated` event `reconcile` used to depend on exclusively) is lost or
 * replaced, `reconcile` can still rebuild the published projection from the snapshot (promotions.json) alone —
 * a published component no longer silently vanishes on the next startup reconcile just because the append-only
 * audit log was rotated/replaced/lost.
 */

function memoryStorage(): StoragePort & { events: LineageEventRecord[] } {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
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
    async getPromotionState(id) {
      return states.get(id) ?? null;
    },
    async putPromotionState(state) {
      states.set(state.artifactId, state);
    },
    async listPromotionStates() {
      return [...states.values()];
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

const draft: ComponentDraft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

const actor = { id: "reviewer-1" };

describe("#9 published 投影の自己完結: lineage が失われても snapshot だけで reconcile が投影を再構築する", () => {
  it("component.generated を含む lineage を全て消しても、published スナップショットの html 複製から onPublish を再適用できる", async () => {
    const storage = memoryStorage();
    storage.events.push({
      id: "g-art-1",
      ts: new Date().toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: {
        artifactId: "art-1",
        html: "<html>original</html>",
        artifactSha256: "a".repeat(64),
        ref: "query://sales/trend?metric=revenue",
        request: "trend chart",
      },
    });
    await storage.putPromotionState({
      artifactId: "art-1",
      status: "schema_proposed",
      updatedAt: new Date().toISOString(),
      data: { draft },
    });

    const seedPromotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async () => {},
    });
    await seedPromotions.act("art-1", { kind: "publish", version: draft.version }, actor);
    // Sanity: the publish transition copied html/sha256/ref/componentType onto the snapshot itself.
    const published = await storage.getPromotionState("art-1");
    expect(published?.data["html"]).toBe("<html>original</html>");
    expect(published?.data["sha256"]).toBe("a".repeat(64));
    expect(published?.data["ref"]).toBe("query://sales/trend?metric=revenue");
    expect(published?.data["componentType"]).toBe(draft.componentType);

    // Simulate a lost/replaced lineage.jsonl: wipe every lineage event (component.generated and
    // component.published included). The promotion-state snapshot (promotions.json) is untouched.
    storage.events.length = 0;

    const applied: { artifactId: string; draft: ComponentDraft; html: string }[] = [];
    const errors: unknown[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async (args) => {
        applied.push(args);
      },
      onError: (ctx, e) => errors.push({ ctx, e }),
    });

    const summary = await promotions.reconcile();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.artifactId).toBe("art-1");
    // The rebuilt html comes from the snapshot's own duplicate, not component.generated (which no longer exists).
    expect(applied[0]!.html).toBe("<html>original</html>");
    expect(applied[0]!.draft).toEqual(draft);
    expect(summary).toEqual({ published: 1, withdrawn: 0, skipped: 0 });
    // No skip/failure is reported (the projection was fully recoverable from the snapshot alone).
    expect(errors).toHaveLength(0);

    // get() also resolves the candidate purely from the snapshot (no component.generated event survives).
    const candidate = await promotions.get("art-1");
    expect(candidate?.status).toBe("published");
    expect(candidate?.html).toBe("<html>original</html>");
    expect(candidate?.sha256).toBe("a".repeat(64));
  });

  it("withdrawn(from:published) スナップショットは html を保持しない(#9 の複製は published 遷移時のみ)が、draft は保持されたまま", async () => {
    const storage = memoryStorage();
    storage.events.push({
      id: "g-art-2",
      ts: new Date().toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: { artifactId: "art-2", html: "<html>x</html>", request: "r" },
    });
    await storage.putPromotionState({
      artifactId: "art-2",
      status: "schema_proposed",
      updatedAt: new Date().toISOString(),
      data: { draft },
    });
    const setup = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async () => {},
      onUnpublish: async () => {},
    });
    await setup.act("art-2", { kind: "publish", version: draft.version }, actor);
    const published = await storage.getPromotionState("art-2");
    expect(published?.data["html"]).toBe("<html>x</html>");

    await setup.act("art-2", { kind: "unpublish" }, actor);
    // The withdrawn snapshot's persist call (candidate.status === "withdrawn" by then) does not re-copy
    // html/sha256/ref/componentType — only a "published" transition does (the self-contained-projection
    // guarantee is specific to the published state reconcile rebuilds a *catalog entry* from). draft (copied
    // unconditionally whenever present) survives regardless, which is all reconcile's non-published branch
    // needs to re-apply onUnpublish.
    const withdrawn = await storage.getPromotionState("art-2");
    expect(withdrawn?.data["html"]).toBeUndefined();
    expect(withdrawn?.data["draft"]).toEqual(draft);

    // With component.generated still intact (only the withdrawn state's own copy was dropped), reconcile can
    // still re-derive the candidate (draft from state, html from component.generated) and re-apply onUnpublish.
    const removed: string[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onUnpublish: async ({ artifactId }) => {
        removed.push(artifactId);
      },
    });
    const summary = await promotions.reconcile();
    expect(removed).toEqual(["art-2"]);
    expect(summary).toEqual({ published: 0, withdrawn: 1, skipped: 0 });
  });
});
