import type {
  FixationRecord,
  LineageEventRecord,
  PromotionState,
  StoragePort,
  UISpec,
} from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import { createFixations, createLineage, createPromotions } from "../src/index.js";

/**
 * Storage-boundary validation: a FixationRecord / PromotionState read back
 * from StoragePort is plain JSON cast to its type with no runtime guarantee, so a corrupted or hand-edited
 * persisted record must be caught at the read boundary rather than propagating a broken shape (most
 * importantly a broken `pinnedSpec`) toward delivery. Fixations.unfixate / invalidate / refreshFingerprint
 * and CandidateStore.load (exercised here via Promotions.get) run every record they read through
 * @kohaku-ui/spec-core's FixationRecordSchema / PromotionStateSchema and treat a validation failure exactly
 * like a real absence, reporting it via the service's onError hook.
 *
 * The delivery-path read (host.lookup -> composer.materializeFixation) is validated independently by the
 * composer (packages/composer/test/compose.test.ts's "materializeFixation: staleness detection" describe
 * block) — it never routes through lineage's Fixations service.
 */

const HASH = "sha256:" + "0".repeat(64);

function fixationStorage(
  rawFixation: unknown,
): StoragePort & { deleteCalls: string[]; putCalls: FixationRecord[] } {
  const deleteCalls: string[] = [];
  const putCalls: FixationRecord[] = [];
  return {
    deleteCalls,
    putCalls,
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage() {
      return [];
    },
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation() {
      return rawFixation as FixationRecord | null;
    },
    async putFixation(record) {
      putCalls.push(record);
    },
    async listFixations() {
      return [];
    },
    async deleteFixation(intentHash) {
      deleteCalls.push(intentHash);
    },
  };
}

/** A pinnedSpec broken enough to fail UISpecSchema (components requires min(1)). */
function corruptedFixationRecord(): unknown {
  return {
    intentHash: HASH,
    canonical: "sales.trend",
    structureHash: "sha256:" + "1".repeat(64),
    pinnedSpec: {
      kohaku: "0.1",
      intent: { canonical: "sales.trend", params: {}, hash: HASH },
      dataVersion: "v0",
      components: [],
      events: [],
      provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
    } as unknown as UISpec,
    fixatedAt: "2026-07-01T00:00:00Z",
    approver: { id: "tester" },
  };
}

describe("Fixations: storage-boundary validation of a corrupted fixation record", () => {
  it("unfixate treats a corrupted record as absent (no delete, no audit) and reports storage.record.invalid", async () => {
    const storage = fixationStorage(corruptedFixationRecord());
    const onError = vi.fn();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, onError });

    await fixations.unfixate(HASH, { id: "admin" });

    expect(storage.deleteCalls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ endpoint: "storage.record.invalid", intentHash: HASH });
  });

  it("invalidate (self-heal) treats a corrupted record as absent (no delete, no audit) and reports storage.record.invalid", async () => {
    const storage = fixationStorage(corruptedFixationRecord());
    const onError = vi.fn();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, onError });

    await fixations.invalidate(HASH, "stale");

    expect(storage.deleteCalls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ endpoint: "storage.record.invalid", intentHash: HASH });
  });

  it("refreshFingerprint treats a corrupted record as absent (no re-stamp) and reports storage.record.invalid", async () => {
    const storage = fixationStorage(corruptedFixationRecord());
    const onError = vi.fn();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, onError });

    await fixations.refreshFingerprint(HASH, "sha256:new-fingerprint");

    expect(storage.putCalls).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ endpoint: "storage.record.invalid", intentHash: HASH });
  });

  it("no onError wired: validation failure is silent (fail-open) and still treated as absent", async () => {
    const storage = fixationStorage(corruptedFixationRecord());
    const fixations = createFixations({ lineage: createLineage({ storage }), storage });

    await expect(fixations.unfixate(HASH, { id: "admin" })).resolves.toBeUndefined();
    expect(storage.deleteCalls).toHaveLength(0);
  });
});

function promotionStorage(rawState: unknown): StoragePort {
  const generated: LineageEventRecord = {
    id: "e1",
    ts: "2026-01-01T00:00:00Z",
    actor: { kind: "system" },
    type: "component.generated",
    payload: { artifactId: "art1", canonical: "sales.trend", html: "<div>x</div>" },
  };
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage(filter) {
      return filter?.type?.includes("component.generated") ? [generated] : [];
    },
    async getPromotionState() {
      return rawState as PromotionState | null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
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

describe("CandidateStore.load: storage-boundary validation of a corrupted promotion-state record", () => {
  it("a promotion state that fails PromotionStateSchema (status is not a string) falls back to in_use and reports storage.record.invalid", async () => {
    const storage = promotionStorage({
      artifactId: "art1",
      status: 42,
      updatedAt: "2026-01-01T00:00:00Z",
      data: {},
    });
    const onError = vi.fn();
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage, onError });

    const candidate = await promotions.get("art1");

    expect(candidate).not.toBeNull();
    expect(candidate!.status).toBe("in_use");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({
      endpoint: "storage.record.invalid",
      artifactId: "art1",
    });
  });

  it("no onError wired: validation failure is silent (fail-open) and the candidate still falls back to in_use", async () => {
    const storage = promotionStorage({
      artifactId: "art1",
      status: 42,
      updatedAt: "2026-01-01T00:00:00Z",
      data: {},
    });
    const promotions = createPromotions({ lineage: createLineage({ storage }), storage });

    const candidate = await promotions.get("art1");

    expect(candidate).not.toBeNull();
    expect(candidate!.status).toBe("in_use");
  });
});
