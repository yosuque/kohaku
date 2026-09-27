import type { FixationRecord, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import type { ActorKind } from "../src/events.js";
import { createFixations } from "../src/index.js";

/**
 * Fixations.replace (design.md #65's catalog migration). Unit-level coverage of the write itself: the
 * TOCTOU guard (revision / fixatedAt / catalogFingerprint / structureHash), the recomputed structureHash
 * and freshly-stamped revision, the re-stamped catalog fingerprint, and the intent.migrated audit record
 * (distinct from intent.fixated — see fixation/service.ts's doc on `replace`).
 */

const HASH = "sha256:" + "0".repeat(64);

function pinnedSpec(markdown: string): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: HASH },
    dataVersion: "pinned@v0",
    components: [{ id: "root", type: "presentMarkdown", props: { markdown } }],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function fixationRecord(overrides: Partial<FixationRecord> = {}): FixationRecord {
  return {
    intentHash: HASH,
    canonical: "sales.trend",
    structureHash: "sha256:" + "1".repeat(64),
    pinnedSpec: pinnedSpec("before migration"),
    fixatedAt: "2026-07-01T00:00:00Z",
    approver: { id: "tester" },
    revision: "rev-1",
    ...overrides,
  };
}

interface RecordedEvent {
  type: string;
  payload: Record<string, unknown>;
  actor?: ActorKind;
  tenant?: string;
}

function harness(
  initial: FixationRecord,
  opts?: { catalogFor?: (tenant?: string) => { fingerprint: string } },
) {
  const fixations = new Map<string, FixationRecord>([[initial.intentHash, initial]]);
  const recorded: RecordedEvent[] = [];
  const storage = {
    async getFixation(intentHash: string) {
      return fixations.get(intentHash) ?? null;
    },
    async putFixation(record: FixationRecord) {
      fixations.set(record.intentHash, record);
    },
    async listFixations() {
      return [...fixations.values()];
    },
    async listLineage() {
      return [];
    },
    async appendLineage() {},
  } as unknown as StoragePort;
  const lineage = {
    record: async (type: string, payload: Record<string, unknown>, actor?: ActorKind, tenant?: string) => {
      recorded.push({ type, payload, actor, tenant });
    },
  } as unknown as Parameters<typeof createFixations>[0]["lineage"];
  return {
    api: createFixations({ lineage, storage, catalogFor: opts?.catalogFor }),
    fixations,
    recorded,
  };
}

const APPROVER = { id: "reviewer-1" };

describe("Fixations.replace (catalog migration)", () => {
  it("returns null and records nothing when no fixation exists for the intentHash", async () => {
    const { api, recorded } = harness(fixationRecord());
    const result = await api.replace("sha256:" + "9".repeat(64), pinnedSpec("after"), { approver: APPROVER });
    expect(result).toBeNull();
    expect(recorded).toHaveLength(0);
  });

  it("with no guard, unconditionally replaces and records intent.migrated (backward compatible)", async () => {
    const { api, fixations, recorded } = harness(fixationRecord());
    const result = await api.replace(HASH, pinnedSpec("after migration"), {
      approver: APPROVER,
      planId: "plan-1",
    });
    expect(result).not.toBeNull();
    expect(fixations.get(HASH)!.pinnedSpec).toEqual(pinnedSpec("after migration"));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.type).toBe("intent.migrated");
    expect(recorded[0]!.payload["intentHash"]).toBe(HASH);
    expect(recorded[0]!.payload["planId"]).toBe("plan-1");
    expect(recorded[0]!.payload["approver"]).toBe(APPROVER.id);
    expect(recorded[0]!.actor).toEqual({ kind: "user", id: APPROVER.id });
  });

  it("recomputes structureHash from the new pinnedSpec (never trusts a caller-supplied value)", async () => {
    const { api, fixations } = harness(fixationRecord());
    const result = await api.replace(HASH, pinnedSpec("after migration"), { approver: APPROVER });
    expect(result!.structureHash).not.toBe(fixationRecord().structureHash);
    expect(fixations.get(HASH)!.structureHash).toBe(result!.structureHash);
  });

  it("stamps a fresh revision distinct from the pre-migration one", async () => {
    const { api } = harness(fixationRecord({ revision: "rev-old" }));
    const result = await api.replace(HASH, pinnedSpec("after"), { approver: APPROVER });
    expect(result!.revision).toBeDefined();
    expect(result!.revision).not.toBe("rev-old");
  });

  it("preserves intentHash / canonical / tenant from the existing record", async () => {
    const { api } = harness(fixationRecord({ tenant: "acme" }));
    const result = await api.replace(HASH, pinnedSpec("after"), { approver: APPROVER, tenant: "acme" });
    expect(result!.intentHash).toBe(HASH);
    expect(result!.canonical).toBe("sales.trend");
    expect(result!.tenant).toBe("acme");
  });

  it("re-stamps the catalog fingerprint from catalogFor when wired (same as fixate)", async () => {
    const { api, fixations } = harness(fixationRecord({ catalogFingerprint: "fp-old" }), {
      catalogFor: () => ({ fingerprint: "fp-new" }),
    });
    const result = await api.replace(HASH, pinnedSpec("after"), { approver: APPROVER });
    expect(result!.catalogFingerprint).toBe("fp-new");
    expect(fixations.get(HASH)!.catalogFingerprint).toBe("fp-new");
  });

  describe("TOCTOU guard", () => {
    it("ifRevision mismatch: does not replace, records nothing", async () => {
      const { api, fixations, recorded } = harness(fixationRecord({ revision: "rev-new" }));
      const result = await api.replace(HASH, pinnedSpec("after"), {
        approver: APPROVER,
        guard: { ifRevision: "rev-old" },
      });
      expect(result).toBeNull();
      expect(fixations.get(HASH)!.pinnedSpec).toEqual(pinnedSpec("before migration"));
      expect(recorded).toHaveLength(0);
    });

    it("ifRevision match: replaces", async () => {
      const { api, recorded } = harness(fixationRecord({ revision: "rev-1" }));
      const result = await api.replace(HASH, pinnedSpec("after"), {
        approver: APPROVER,
        guard: { ifRevision: "rev-1" },
      });
      expect(result).not.toBeNull();
      expect(recorded).toHaveLength(1);
    });

    it("ifFixatedAt mismatch (legacy record with no revision) does not replace", async () => {
      const record = fixationRecord();
      delete (record as { revision?: string }).revision;
      const { api, recorded } = harness({ ...record, fixatedAt: "2026-08-01T00:00:00Z" });
      const result = await api.replace(HASH, pinnedSpec("after"), {
        approver: APPROVER,
        guard: { ifFixatedAt: "2026-07-01T00:00:00Z" },
      });
      expect(result).toBeNull();
      expect(recorded).toHaveLength(0);
    });

    it("ifCatalogFingerprint mismatch does not replace", async () => {
      const { api, recorded } = harness(fixationRecord({ catalogFingerprint: "fp-new" }));
      const result = await api.replace(HASH, pinnedSpec("after"), {
        approver: APPROVER,
        guard: { ifCatalogFingerprint: "fp-old" },
      });
      expect(result).toBeNull();
      expect(recorded).toHaveLength(0);
    });

    it("ifStructureHash mismatch (the plan was built against a structure that has since changed) does not replace", async () => {
      const { api, fixations, recorded } = harness(
        fixationRecord({ structureHash: "sha256:" + "2".repeat(64) }),
      );
      const result = await api.replace(HASH, pinnedSpec("after"), {
        approver: APPROVER,
        guard: { ifStructureHash: "sha256:" + "3".repeat(64) },
      });
      expect(result).toBeNull();
      expect(fixations.get(HASH)!.pinnedSpec).toEqual(pinnedSpec("before migration"));
      expect(recorded).toHaveLength(0);
    });

    it("ifStructureHash match replaces", async () => {
      const record = fixationRecord();
      const { api, recorded } = harness(record);
      const result = await api.replace(HASH, pinnedSpec("after"), {
        approver: APPROVER,
        guard: { ifStructureHash: record.structureHash },
      });
      expect(result).not.toBeNull();
      expect(recorded).toHaveLength(1);
    });
  });
});
