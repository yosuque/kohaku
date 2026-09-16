import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * N+1 avoidance in reconcile() and listByStatus() (perf): both used to call storage.listLineage once per
 * candidate (usage.forArtifact, the component.generated single lookup, and -- reconcile only -- the
 * component.published / component.withdrawn existing-audit-record check), so the number of listLineage round
 * trips scaled linearly with the number of published/withdrawn snapshots. Both now build a small, fixed set of
 * bulk indexes once up front instead. These tests pin that the call count stays constant as the candidate
 * population grows.
 */

function countingStorage(): StoragePort & {
  events: LineageEventRecord[];
  states: Map<string, PromotionState>;
  listLineageCalls: number;
} {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const storage: StoragePort & {
    events: LineageEventRecord[];
    states: Map<string, PromotionState>;
    listLineageCalls: number;
  } = {
    events,
    states,
    listLineageCalls: 0,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
      events.push(event);
    },
    async listLineage(filter = {}) {
      storage.listLineageCalls++;
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
  return storage;
}

const draft: ComponentDraft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

/** Seeds `count` independent published candidates, each self-contained (#9: html/sha256 duplicated onto the
 * snapshot) with its own component.generated event, so every candidate can be fully resolved without any
 * per-candidate fallback lookup. */
function seedPublishedCandidates(storage: ReturnType<typeof countingStorage>, count: number): void {
  for (let i = 0; i < count; i++) {
    const artifactId = `art-${i}`;
    storage.events.push({
      id: `g-${artifactId}`,
      ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      actor: { kind: "model" },
      type: "component.generated",
      payload: { artifactId, html: `<html>${i}</html>`, request: "r" },
    });
    storage.states.set(artifactId, {
      artifactId,
      status: "published",
      updatedAt: new Date().toISOString(),
      data: {
        draft,
        html: `<html>${i}</html>`,
        sha256: "a".repeat(64),
        componentType: draft.componentType,
      },
    });
  }
}

describe("reconcile() の listLineage 呼び出し回数は候補数に比例しない(N+1 回避)", () => {
  it.each([3, 30])("published 候補が %i 件でも listLineage 呼び出しは一定回数", async (count) => {
    const storage = countingStorage();
    seedPublishedCandidates(storage, count);
    const applied: string[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async ({ artifactId }) => {
        applied.push(artifactId);
      },
    });

    storage.listLineageCalls = 0;
    const summary = await promotions.reconcile();
    expect(applied).toHaveLength(count);
    expect(summary.published).toBe(count);
    // Fixed set of bulk index fetches (usage, component.generated, component.published, component.withdrawn)
    // regardless of how many candidates were scanned -- not one listLineage call per candidate.
    expect(storage.listLineageCalls).toBe(4);
  });
});

describe("listByStatus() の listLineage 呼び出し回数は候補数に比例しない(N+1 回避)", () => {
  it.each([3, 30])("published 候補が %i 件でも listLineage 呼び出しは一定回数", async (count) => {
    const storage = countingStorage();
    seedPublishedCandidates(storage, count);
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    storage.listLineageCalls = 0;
    const candidates = await promotions.listByStatus("published");
    expect(candidates).toHaveLength(count);
    // Fixed set of bulk index fetches (usage, component.generated) regardless of candidate count.
    expect(storage.listLineageCalls).toBe(2);
  });
});
