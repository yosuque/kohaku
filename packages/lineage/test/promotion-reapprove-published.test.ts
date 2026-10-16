import type { LineageEventRecord, PromotionState, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createLineage, createPromotions } from "../src/index.js";

/**
 * Re-approving an already-published candidate re-runs onPublish (idempotent projection re-application). A
 * published snapshot that is missing its draft or html is a state inconsistency, so that path fails fast with
 * a clear error instead of handing the projection an `undefined` through a non-null assertion.
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

const reviewer = { id: "reviewer-1" };

/** Seeds a `published` snapshot; `data` decides whether the draft / html needed by the projection are present. */
async function seedPublished(
  storage: ReturnType<typeof memoryStorage>,
  artifactId: string,
  opts: { draft: boolean; html: boolean },
): Promise<void> {
  storage.events.push({
    id: `g-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    // No html here: the snapshot's own data is the only place the html could come from.
    payload: { artifactId, request: "r" },
  });
  await storage.putPromotionState({
    artifactId,
    status: "published",
    updatedAt: new Date().toISOString(),
    data: {
      ...(opts.draft ? { draft } : {}),
      ...(opts.html ? { html: "<html></html>" } : {}),
    },
  });
}

describe("approve() on an already-published candidate", () => {
  it("re-runs onPublish with the persisted draft and html", async () => {
    const storage = memoryStorage();
    await seedPublished(storage, "a1", { draft: true, html: true });
    const calls: Array<{ artifactId: string; html: string }> = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async (args) => {
        calls.push({ artifactId: args.artifactId, html: args.html });
      },
    });

    const result = await promotions.approve("a1", draft, reviewer);

    expect(result.status).toBe("published");
    expect(calls).toEqual([{ artifactId: "a1", html: "<html></html>" }]);
  });

  it("fails fast with a clear error when the published snapshot has no draft", async () => {
    const storage = memoryStorage();
    await seedPublished(storage, "a1", { draft: false, html: true });
    const calls: unknown[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async (args) => {
        calls.push(args);
      },
    });

    await expect(promotions.approve("a1", draft, reviewer)).rejects.toThrow(
      "re-approve of a published artifact requires the persisted schema draft (artifact a1)",
    );
    expect(calls).toEqual([]);
  });

  it("fails fast with a clear error when the published snapshot has no html", async () => {
    const storage = memoryStorage();
    await seedPublished(storage, "a1", { draft: true, html: false });
    const calls: unknown[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async (args) => {
        calls.push(args);
      },
    });

    await expect(promotions.approve("a1", draft, reviewer)).rejects.toThrow(
      "re-approve of a published artifact requires the artifact html (artifact a1)",
    );
    expect(calls).toEqual([]);
  });

  it("does not need a draft or html when no onPublish is configured", async () => {
    const storage = memoryStorage();
    await seedPublished(storage, "a1", { draft: false, html: false });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    const result = await promotions.approve("a1", draft, reviewer);

    expect(result.status).toBe("published");
  });
});
