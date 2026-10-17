import type { LineageEventRecord, Principal, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * Write ordering of Promotions.act() for the generic (non-publish, non-unpublish) action kinds: the audit event
 * is recorded first and the snapshot (state authority) is persisted second, deliberately. A throwing record then
 * leaves the transition unpersisted, so a retry re-runs the same action (at worst a duplicated audit event), and
 * a lost `component.reviewed` can never let a retried approve() publish without the human-approval evidence
 * SPEC LIN-PRM-001 requires.
 */

function recordingStorage(opts: { failRecordOnce?: string } = {}): StoragePort & {
  events: LineageEventRecord[];
  states: Map<string, PromotionState>;
  /** Interleaved write log: `persist` for putPromotionState, `record:<type>` for appendLineage. */
  sequence: string[];
} {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const sequence: string[] = [];
  let failRecordOnce = opts.failRecordOnce;
  return {
    events,
    states,
    sequence,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
      if (failRecordOnce != null && event.type === failRecordOnce) {
        failRecordOnce = undefined;
        throw new Error("lineage down");
      }
      sequence.push(`record:${event.type}`);
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
      sequence.push("persist");
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

function generated(storage: { events: LineageEventRecord[] }, artifactId: string): void {
  // Seeded directly (not through appendLineage) so it does not show up in the write sequence under test.
  storage.events.push({
    id: `g-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: "<html></html>", request: "r" },
  });
}

describe("Promotions.act(): record the audit event first, persist the snapshot second", () => {
  const actor: Principal = { id: "admin-1" };

  it("records the audit event before persisting the snapshot", async () => {
    const storage = recordingStorage();
    generated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await promotions.act("a1", { kind: "nominate", by: actor }, actor);

    expect(storage.sequence).toEqual(["record:component.nominated", "persist"]);
  });

  it("a throwing record leaves the snapshot unchanged (state not advanced)", async () => {
    const storage = recordingStorage({ failRecordOnce: "component.nominated" });
    generated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await expect(promotions.act("a1", { kind: "nominate", by: actor }, actor)).rejects.toThrow(
      "lineage down",
    );

    expect(storage.sequence).toEqual([]);
    expect(storage.states.size).toBe(0);
    expect(storage.events.filter((e) => e.type === "component.nominated")).toEqual([]);
  });

  it("after a throwing component.reviewed record, a retried approve() still records component.reviewed before any component.published", async () => {
    const storage = recordingStorage({ failRecordOnce: "component.reviewed" });
    generated(storage, "a1");
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async () => {},
    });
    const draft: ComponentDraft = {
      componentType: "sales.customX",
      version: "1.0.0",
      intentName: "sales.customX",
      description: "test draft",
    };

    await expect(promotions.approve("a1", draft, actor)).rejects.toThrow("lineage down");
    // The failed record must not have advanced the snapshot past the review stage.
    expect(storage.states.get("a1")?.status).toBe("in_review");

    const result = await promotions.approve("a1", draft, actor);
    expect(result.status).toBe("published");

    const types = storage.events.map((e) => e.type);
    expect(types).toContain("component.reviewed");
    expect(types.indexOf("component.reviewed")).toBeLessThan(types.indexOf("component.published"));
  });
});
