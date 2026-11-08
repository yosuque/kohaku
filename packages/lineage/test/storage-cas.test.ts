import {
  type FixationRecord,
  type LineageEventRecord,
  type Principal,
  type PromotionState,
  type PutFixationOptions,
  type PutPromotionStateOptions,
  StorageConflictError,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { type ComponentDraft, createFixations, createLineage, createPromotions } from "../src/index.js";

/**
 * The lineage services against a compare-and-set StoragePort (`supportsCompareAndSet`): promotion and
 * fixation writes carry the revision they read, a concurrent writer's change surfaces as a
 * StorageConflictError, and the loser never overwrites it. The fake below is the smallest port that honors
 * `expectedRevision` (the real adapters are covered by port-contracts); its hooks let a test land "another
 * instance's" write at an exact point of the service's read -> write sequence.
 */

const HASH = "sha256:" + "0".repeat(64);
const actor: Principal = { id: "admin-1" };

function pinnedSpec(marker: string): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: HASH },
    dataVersion: "pinned@v0",
    components: [{ id: "root", type: "presentMarkdown", props: { markdown: marker } }],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function fixationRecord(marker: string, revision?: string, fingerprint = "fp1"): FixationRecord {
  return {
    intentHash: HASH,
    canonical: "sales.trend",
    structureHash: "sha256:" + "1".repeat(64),
    pinnedSpec: pinnedSpec(marker),
    fixatedAt: "2026-07-01T00:00:00Z",
    approver: { id: "tester" },
    catalogFingerprint: fingerprint,
    ...(revision != null ? { revision } : {}),
  };
}

interface CasStorage extends StoragePort {
  events: LineageEventRecord[];
  states: Map<string, PromotionState>;
  fixations: Map<string, FixationRecord>;
  /** The options every putPromotionState / putFixation / deleteFixation call carried, in order. */
  promotionWrites: { state: PromotionState; options: PutPromotionStateOptions | undefined }[];
  fixationWrites: { record: FixationRecord; options: PutFixationOptions | undefined }[];
  fixationDeletes: { intentHash: string; options: { expectedRevision?: string } | undefined }[];
  /** One-shot hooks that simulate another instance writing at an exact point (cleared after firing). */
  hooks: {
    afterPromotionRead?: () => void;
    beforeAppend?: (event: LineageEventRecord) => void;
    afterFixationRead?: () => void;
    afterListGenerated?: () => void;
  };
}

function casStorage(options: { supportsCompareAndSet?: boolean } = {}): CasStorage {
  const events: LineageEventRecord[] = [];
  const states = new Map<string, PromotionState>();
  const fixations = new Map<string, FixationRecord>();
  const hooks: CasStorage["hooks"] = {};
  const fire = (name: keyof CasStorage["hooks"], ...args: unknown[]): void => {
    const hook = hooks[name] as ((...a: unknown[]) => void) | undefined;
    if (hook == null) return;
    delete hooks[name];
    hook(...args);
  };
  const storage: CasStorage = {
    events,
    states,
    fixations,
    promotionWrites: [],
    fixationWrites: [],
    fixationDeletes: [],
    hooks,
    ...(options.supportsCompareAndSet === false ? {} : { supportsCompareAndSet: true as const }),
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage(event) {
      fire("beforeAppend", event);
      events.push(event);
    },
    async listLineage(filter = {}) {
      let result = events;
      if (filter.type != null) result = result.filter((e) => filter.type!.includes(e.type));
      if (filter.artifactId != null)
        result = result.filter((e) => e.payload["artifactId"] === filter.artifactId);
      const out = result.slice(-(filter.limit ?? 200));
      if (filter.type?.includes("component.generated") === true) fire("afterListGenerated");
      return out;
    },
    async getPromotionState(id) {
      const state = states.get(id) ?? null;
      const snapshot = state == null ? null : (JSON.parse(JSON.stringify(state)) as PromotionState);
      fire("afterPromotionRead");
      return snapshot;
    },
    async putPromotionState(state, putOptions) {
      storage.promotionWrites.push({ state, options: putOptions });
      const expected = putOptions?.expectedRevision;
      if (expected !== undefined) {
        const current = states.get(state.artifactId);
        const ok = expected === null ? current == null : current?.revision === expected;
        if (!ok) throw new StorageConflictError("promotion", state.artifactId);
      }
      states.set(state.artifactId, state);
    },
    async putPromotionStates(batch) {
      for (const state of batch) states.set(state.artifactId, state);
    },
    async listPromotionStates() {
      return [...states.values()];
    },
    async getFixation(intentHash) {
      const record = fixations.get(intentHash) ?? null;
      const snapshot = record == null ? null : (JSON.parse(JSON.stringify(record)) as FixationRecord);
      fire("afterFixationRead");
      return snapshot;
    },
    async putFixation(record, putOptions) {
      storage.fixationWrites.push({ record, options: putOptions });
      const current = fixations.get(record.intentHash);
      if (putOptions?.ifPresent === true && current == null) return;
      const expected = putOptions?.expectedRevision;
      if (expected !== undefined) {
        const ok = expected === null ? current == null : current?.revision === expected;
        if (!ok) throw new StorageConflictError("fixation", record.intentHash);
      }
      fixations.set(record.intentHash, record);
    },
    async listFixations() {
      return [...fixations.values()];
    },
    async deleteFixation(intentHash, _tenant, deleteOptions) {
      storage.fixationDeletes.push({ intentHash, options: deleteOptions });
      const expected = deleteOptions?.expectedRevision;
      if (expected !== undefined && fixations.get(intentHash)?.revision !== expected) {
        throw new StorageConflictError("fixation", intentHash);
      }
      fixations.delete(intentHash);
    },
  };
  return storage;
}

function seedGenerated(storage: CasStorage, artifactId: string): void {
  storage.events.push({
    id: `g-${artifactId}`,
    ts: new Date().toISOString(),
    actor: { kind: "model" },
    type: "component.generated",
    payload: { artifactId, html: "<html></html>", request: "r" },
  });
}

const draft: ComponentDraft = {
  componentType: "sales.customX",
  version: "1.0.0",
  intentName: "sales.customX",
  description: "test draft",
};

describe("promotion writes carry the revision they read", () => {
  it("stamps a fresh revision on every write and chains expectedRevision from the previous one", async () => {
    const storage = casStorage();
    seedGenerated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await promotions.act("a1", { kind: "nominate", by: actor }, actor);
    await promotions.act("a1", { kind: "judge.start" }, actor);

    const [first, second] = storage.promotionWrites;
    // No state existed: the first write must be the creator ...
    expect(first?.options).toEqual({ expectedRevision: null });
    expect(typeof first?.state.revision).toBe("string");
    // ... and the next one is conditional on exactly what the first one wrote.
    expect(second?.options).toEqual({ expectedRevision: first?.state.revision });
    expect(second?.state.revision).not.toBe(first?.state.revision);
  });

  it("passes no condition for a legacy record that has no revision (one unguarded write, which then stamps one)", async () => {
    const storage = casStorage();
    seedGenerated(storage, "a1");
    storage.states.set("a1", { artifactId: "a1", status: "candidate", updatedAt: "x", data: {} });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await promotions.act("a1", { kind: "judge.start" }, actor);

    expect(storage.promotionWrites[0]?.options).toBeUndefined();
    expect(typeof storage.states.get("a1")?.revision).toBe("string");
  });

  it("passes no options at all to a port that does not declare supportsCompareAndSet", async () => {
    const storage = casStorage({ supportsCompareAndSet: false });
    seedGenerated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    await promotions.act("a1", { kind: "nominate", by: actor }, actor);

    expect(storage.promotionWrites[0]?.options).toBeUndefined();
    // The revision is still stamped, so enabling a CAS adapter later needs no data migration.
    expect(typeof storage.promotionWrites[0]?.state.revision).toBe("string");
  });

  it("stamps a revision on the batch nomination write too, which stays unconditional", async () => {
    const storage = casStorage();
    seedGenerated(storage, "a1");
    const batches: PromotionState[][] = [];
    const original = storage.putPromotionStates!.bind(storage);
    storage.putPromotionStates = async (states) => {
      batches.push(states);
      await original(states);
    };
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      policy: { minUses: 0, minDistinctSessions: 0, judgeBlocking: true },
    });

    await promotions.evaluateAndList();

    expect(batches).toHaveLength(1);
    expect(typeof batches[0]?.[0]?.revision).toBe("string");
    // The batch method has no expectedRevision parameter, and no per-state write happened.
    expect(storage.promotionWrites).toEqual([]);
  });
});

describe("act() with a concurrent writer", () => {
  it("rechecks the stored revision before recording the audit event: a change since the load throws, records nothing and keeps the other writer's state", async () => {
    const storage = casStorage();
    seedGenerated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });
    await promotions.act("a1", { kind: "nominate", by: actor }, actor);
    const before = storage.events.length;

    // Another instance moves the artifact on after this act() has loaded it, before its recheck.
    storage.hooks.afterListGenerated = () => {
      storage.states.set("a1", {
        ...storage.states.get("a1")!,
        status: "withdrawn",
        revision: "other-writer",
      });
    };

    await expect(promotions.act("a1", { kind: "judge.start" }, actor)).rejects.toBeInstanceOf(
      StorageConflictError,
    );

    expect(storage.events.length).toBe(before);
    expect(storage.states.get("a1")).toMatchObject({ status: "withdrawn", revision: "other-writer" });
  });

  it("a write that lands between the recheck and the state write still cannot overwrite: the CAS write throws and the other state stays (the recorded audit event is the documented orphan)", async () => {
    const storage = casStorage();
    seedGenerated(storage, "a1");
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });
    await promotions.act("a1", { kind: "nominate", by: actor }, actor);
    await promotions.act("a1", { kind: "judge.start" }, actor);
    await promotions.act("a1", { kind: "judge.result", verdict: { pass: true, score: 1 } }, actor);

    // The audit append is the window between the recheck and the CAS write.
    storage.hooks.beforeAppend = (event) => {
      if (event.type !== "component.reviewed") return;
      storage.states.set("a1", {
        ...storage.states.get("a1")!,
        status: "rejected",
        revision: "other-writer",
      });
    };

    await expect(
      promotions.act("a1", { kind: "review.approve", reviewer: actor }, actor),
    ).rejects.toBeInstanceOf(StorageConflictError);

    expect(storage.states.get("a1")).toMatchObject({ status: "rejected", revision: "other-writer" });
    // The orphan audit event exists ...
    expect(storage.events.some((e) => e.type === "component.reviewed")).toBe(true);
    // ... and reconcile ignores an event that has no matching state: nothing is projected, nothing throws.
    const projected: string[] = [];
    const reconciler = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async (args) => {
        projected.push(args.artifactId);
      },
    });
    const summary = await reconciler.reconcile();
    expect(summary).toEqual({ published: 0, withdrawn: 0, skipped: 0 });
    expect(projected).toEqual([]);
  });

  it("publish: a concurrent change after the load throws without publishing, auditing or projecting", async () => {
    const storage = casStorage();
    seedGenerated(storage, "a1");
    const published: string[] = [];
    const promotions = createPromotions({
      lineage: createLineage({ storage }),
      storage,
      onPublish: async (args) => {
        published.push(args.artifactId);
      },
      // The last hook before the snapshot write: the other instance's write lands here.
      validatePublish: async () => {
        storage.states.set("a1", {
          ...storage.states.get("a1")!,
          status: "withdrawn",
          revision: "other-writer",
        });
      },
    });

    await expect(promotions.approve("a1", draft, actor)).rejects.toBeInstanceOf(StorageConflictError);

    expect(storage.states.get("a1")).toMatchObject({ status: "withdrawn", revision: "other-writer" });
    expect(storage.events.some((e) => e.type === "component.published")).toBe(false);
    expect(published).toEqual([]);
  });
});

describe("fixation writes carry the revision they read", () => {
  function fixations(storage: CasStorage) {
    return createFixations({ lineage: createLineage({ storage }), storage });
  }

  it("replace vs refreshFingerprint: a refresh that read the old record cannot put the old pinnedSpec back", async () => {
    const storage = casStorage();
    storage.fixations.set(HASH, fixationRecord("old", "r1"));
    const api = fixations(storage);

    // refreshFingerprint reads r1; before its write lands another instance replaces the pinnedSpec (r2).
    storage.hooks.afterFixationRead = () => {
      storage.fixations.set(HASH, fixationRecord("new", "r2", "fp-new"));
    };

    await expect(api.refreshFingerprint(HASH, "fp2")).rejects.toBeInstanceOf(StorageConflictError);

    const stored = storage.fixations.get(HASH);
    expect(stored?.revision).toBe("r2");
    expect(stored?.pinnedSpec.components[0]?.props).toEqual({ markdown: "new" });
    expect(storage.fixationWrites[0]?.options).toEqual({ ifPresent: true, expectedRevision: "r1" });
  });

  it("replace: a concurrent change throws, writes nothing and records no intent.migrated", async () => {
    const storage = casStorage();
    storage.fixations.set(HASH, fixationRecord("old", "r1"));
    const api = fixations(storage);
    storage.hooks.afterFixationRead = () => {
      storage.fixations.set(HASH, fixationRecord("other", "r2"));
    };

    await expect(api.replace(HASH, pinnedSpec("migrated"), { approver: actor })).rejects.toBeInstanceOf(
      StorageConflictError,
    );

    expect(storage.fixations.get(HASH)?.revision).toBe("r2");
    expect(storage.events.some((e) => e.type === "intent.migrated")).toBe(false);
  });

  it("replace stamps a fresh revision and is conditional on the one it read", async () => {
    const storage = casStorage();
    storage.fixations.set(HASH, fixationRecord("old", "r1"));
    const api = fixations(storage);

    const record = await api.replace(HASH, pinnedSpec("migrated"), { approver: actor });

    expect(record?.revision).not.toBe("r1");
    expect(storage.fixationWrites[0]?.options).toEqual({ ifPresent: true, expectedRevision: "r1" });
  });

  it("unfixate: deletes conditionally; a fixation re-approved in between survives and no intent.unfixated is recorded", async () => {
    const storage = casStorage();
    storage.fixations.set(HASH, fixationRecord("old", "r1"));
    const api = fixations(storage);
    storage.hooks.afterFixationRead = () => {
      storage.fixations.set(HASH, fixationRecord("re-approved", "r2"));
    };

    await expect(api.unfixate(HASH, actor)).rejects.toBeInstanceOf(StorageConflictError);

    expect(storage.fixations.get(HASH)?.revision).toBe("r2");
    expect(storage.fixationDeletes[0]?.options).toEqual({ expectedRevision: "r1" });
    expect(storage.events.some((e) => e.type === "intent.unfixated")).toBe(false);
  });

  it("invalidate (self-heal): passes the read revision to deleteFixation", async () => {
    const storage = casStorage();
    storage.fixations.set(HASH, fixationRecord("old", "r1", "fp-old"));
    const api = fixations(storage);

    await api.invalidate(HASH, "stale", { guard: { ifCatalogFingerprint: "fp-old" } });

    expect(storage.fixationDeletes[0]?.options).toEqual({ expectedRevision: "r1" });
    expect(storage.fixations.has(HASH)).toBe(false);
  });

  it("a legacy fixation without a revision is written and deleted unconditionally", async () => {
    const storage = casStorage();
    storage.fixations.set(HASH, fixationRecord("old"));
    const api = fixations(storage);

    await api.refreshFingerprint(HASH, "fp2");
    await api.unfixate(HASH, actor);

    expect(storage.fixationWrites[0]?.options).toEqual({ ifPresent: true });
    expect(storage.fixationDeletes[0]?.options).toBeUndefined();
  });

  it("a port that does not declare supportsCompareAndSet keeps the pre-CAS call shapes", async () => {
    const storage = casStorage({ supportsCompareAndSet: false });
    storage.fixations.set(HASH, fixationRecord("old", "r1"));
    const api = fixations(storage);

    await api.refreshFingerprint(HASH, "fp2");
    await api.unfixate(HASH, actor);

    expect(storage.fixationWrites[0]?.options).toEqual({ ifPresent: true });
    expect(storage.fixationDeletes[0]?.options).toBeUndefined();
  });

  it("fixate stays an unconditional human overwrite and stamps a fresh revision", async () => {
    const storage = casStorage();
    storage.fixations.set(HASH, fixationRecord("old", "r1"));
    const api = fixations(storage);

    const record = await api.fixate({ pinnedSpec: pinnedSpec("re-approved"), approver: actor });

    expect(storage.fixationWrites[0]?.options).toBeUndefined();
    expect(record.revision).not.toBe("r1");
  });
});
