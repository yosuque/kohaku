import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * A candidate's `component.generated` payload carries `kit` / `generatorVersion` / `model`
 * (design.md #54), but that provenance was previously dropped on the floor by candidate-store.ts — nothing ever
 * read it into the promotion record. This is the fix: `PromotionCandidate.origin` is read from the
 * payload and persisted to `data.origin`, kept across every transition (not just publish, unlike the
 * html/sha256/ref self-contained projection — #9 — which is deliberately publish-only).
 */

function memoryStorage(): StoragePort & {
  events: LineageEventRecord[];
  states: Map<string, PromotionState>;
} {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
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

const actor = { id: "reviewer-1" };

describe("promotion candidates carry kit/generatorVersion/model as origin", () => {
  it("get() surfaces origin read straight from the component.generated payload", async () => {
    const storage = memoryStorage();
    storage.events.push({
      id: "g-1",
      ts: new Date().toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: {
        artifactId: "art-1",
        artifactSha256: "a".repeat(64),
        canonical: "sales.custom",
        request: "trend chart",
        kit: { id: "default", version: "1.0.0" },
        generatorVersion: "l2-2026-09",
        model: "claude-sonnet-5",
      },
    });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });
    const candidate = await promotions.get("art-1");
    expect(candidate?.origin).toEqual({
      kit: { id: "default", version: "1.0.0" },
      generatorVersion: "l2-2026-09",
      model: "claude-sonnet-5",
    });
  });

  it("omits origin entirely when the payload carries none of kit/generatorVersion/model", async () => {
    const storage = memoryStorage();
    storage.events.push({
      id: "g-2",
      ts: new Date().toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: { artifactId: "art-2", artifactSha256: "b".repeat(64), canonical: "sales.custom" },
    });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });
    const candidate = await promotions.get("art-2");
    expect(candidate?.origin).toBeUndefined();
  });

  it("origin is persisted to data.origin at nominate time (before publish), unlike html/sha256/ref (#9, publish-only)", async () => {
    const storage = memoryStorage();
    storage.events.push({
      id: "g-3",
      ts: new Date().toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: {
        artifactId: "art-3",
        artifactSha256: "c".repeat(64),
        canonical: "sales.custom",
        html: "<html>x</html>",
        kit: { id: "default", version: "1.0.0" },
        generatorVersion: "l2-2026-09",
      },
    });
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });
    await promotions.act("art-3", { kind: "nominate", by: actor }, actor);
    const persisted = storage.states.get("art-3")!;
    expect(persisted.data["origin"]).toEqual({
      kit: { id: "default", version: "1.0.0" },
      generatorVersion: "l2-2026-09",
    });
    // html is NOT copied at nominate time (#9 remains publish-only) -- origin and the projection follow
    // independent rules.
    expect(persisted.data["html"]).toBeUndefined();
  });

  it("origin survives once the component.generated event ages out of the scan window (falls back to the persisted copy), same as #9's html/sha256/ref projection", async () => {
    const storage = memoryStorage();
    storage.events.push({
      id: "g-4",
      ts: new Date().toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: {
        artifactId: "art-4",
        artifactSha256: "d".repeat(64),
        canonical: "sales.custom",
        html: "<html>origin-test</html>",
        ref: "query://sales/trend?metric=revenue",
        kit: { id: "default", version: "1.0.0" },
      },
    });
    const draft: ComponentDraft = {
      componentType: "sales.customY",
      version: "1.0.0",
      intentName: "sales.customY",
      description: "origin test draft",
    };
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 1, minDistinctSessions: 1, judgeBlocking: false },
    });
    await promotions.act("art-4", { kind: "nominate", by: actor }, actor);
    await promotions.act("art-4", { kind: "judge.start" }, actor);
    await promotions.act("art-4", { kind: "judge.result", verdict: { pass: true, score: 1 } }, actor);
    await promotions.act("art-4", { kind: "review.approve", reviewer: actor }, actor);
    await promotions.act("art-4", { kind: "schema.propose", draft }, actor);
    await promotions.act("art-4", { kind: "publish", version: draft.version }, actor);
    expect(storage.states.get("art-4")!.data["origin"]).toEqual({ kit: { id: "default", version: "1.0.0" } });
    // Sanity: #9's own publish-time projection is also present (html copied alongside origin).
    expect(storage.states.get("art-4")!.data["html"]).toBe("<html>origin-test</html>");

    // Simulate a lost/replaced lineage.jsonl: the component.generated event is gone, but the snapshot
    // (self-contained since publish, #9) still makes the candidate loadable, and origin comes along.
    storage.events.length = 0;
    const candidate = await promotions.get("art-4");
    expect(candidate?.status).toBe("published");
    expect(candidate?.origin).toEqual({ kit: { id: "default", version: "1.0.0" } });
  });
});
