import type { LineageEventRecord, Principal, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createLineage, createPromotions } from "../src/index.js";

/**
 * Write ordering of Promotions.act() for the generic (non-publish, non-unpublish) action kinds: the snapshot
 * (state authority) is persisted first and the audit event is recorded second -- the same state-first,
 * audit-second order as the publish path and the fixation service. A failing persist therefore must not leave
 * an audit event describing a transition that never happened.
 */

function recordingStorage(opts: { failPersist?: boolean } = {}): StoragePort & {
  events: LineageEventRecord[];
  states: Map<string, PromotionState>;
  /** Interleaved write log: `persist` for putPromotionState, `record:<type>` for appendLineage. */
  sequence: string[];
} {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const sequence: string[] = [];
  return {
    events,
    states,
    sequence,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
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
      if (opts.failPersist === true) throw new Error("storage down");
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

describe("Promotions.act(): persist the snapshot first, record the audit event second", () => {
  const actor: Principal = { id: "admin-1" };

  it("persists the snapshot before recording the audit event", async () => {
    const storage = recordingStorage();
    generated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await promotions.act("a1", { kind: "nominate", by: actor }, actor);

    expect(storage.sequence).toEqual(["persist", "record:component.nominated"]);
  });

  it("a failing persist leaves no audit event behind", async () => {
    const storage = recordingStorage({ failPersist: true });
    generated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await expect(promotions.act("a1", { kind: "nominate", by: actor }, actor)).rejects.toThrow(
      "storage down",
    );

    expect(storage.sequence).toEqual([]);
    expect(storage.events.filter((e) => e.type === "component.nominated")).toEqual([]);
    expect(storage.states.size).toBe(0);
  });
});
