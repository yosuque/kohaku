import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createLineage } from "../src/index.js";

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

describe("Lineage.policyApplied", () => {
  it("records a policy.applied event with the full payload", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.policyApplied(
      {
        policyId: "sha256:new",
        previousPolicyId: "sha256:old",
        version: 1,
        label: "v2",
        changedPaths: ["defaults.compose.allowL2"],
        tenants: ["tenant-a"],
      },
      { kind: "user", id: "alice" },
    );

    expect(storage.events).toHaveLength(1);
    const event = storage.events[0]!;
    expect(event.type).toBe("policy.applied");
    expect(event.actor).toEqual({ kind: "user", id: "alice" });
    expect(event.payload).toEqual({
      policyId: "sha256:new",
      previousPolicyId: "sha256:old",
      version: 1,
      label: "v2",
      changedPaths: ["defaults.compose.allowL2"],
      tenants: ["tenant-a"],
    });
  });

  it("omits previousPolicyId/label from the payload when unset (no undefined keys left behind)", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.policyApplied({
      policyId: "sha256:first",
      version: 1,
      changedPaths: ["defaults"],
      tenants: [],
    });

    const event = storage.events[0]!;
    expect(Object.keys(event.payload).sort()).toEqual(["changedPaths", "policyId", "tenants", "version"]);
  });

  it("stamps the tenant onto the record when given", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.policyApplied(
      { policyId: "sha256:x", version: 1, changedPaths: [], tenants: [] },
      undefined,
      "tenant-a",
    );

    expect(storage.events[0]!.tenant).toBe("tenant-a");
  });

  it("defaults to a system actor when none is given", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });

    await lineage.policyApplied({ policyId: "sha256:x", version: 1, changedPaths: [], tenants: [] });

    expect(storage.events[0]!.actor).toEqual({ kind: "system" });
  });

  it("is retrievable via list({type: ['policy.applied']})", async () => {
    const storage = memoryStorage();
    const lineage = createLineage({ storage });
    await lineage.policyApplied({ policyId: "sha256:x", version: 1, changedPaths: [], tenants: [] });
    await lineage.record("view.composed", { specHash: "irrelevant" });

    const events = await lineage.list({ type: ["policy.applied"] });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("policy.applied");
  });
});
