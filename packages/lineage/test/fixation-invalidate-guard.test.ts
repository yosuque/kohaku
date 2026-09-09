import type { FixationRecord, StoragePort, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createFixations } from "../src/index.js";

// invalidate's TOCTOU guard: fixes, at the service unit level, that if the fixation at the time of the stale
// decision (guard.ifCatalogFingerprint) and the current fixation are different (re-approved after the decision), it does not delete.

const HASH = "sha256:" + "0".repeat(64);

/** A valid minimal pinnedSpec (passes FixationRecordSchema — invalidate now reads records through it). */
function validPinnedSpec(): UISpec {
  return {
    kohaku: "0.1",
    intent: { canonical: "sales.trend", params: {}, hash: HASH },
    dataVersion: "pinned@v0",
    components: [{ id: "root", type: "presentMarkdown", props: { markdown: "pinned" } }],
    events: [],
    provenance: { tier: "L0", composedBy: "fixture", cache: "miss" },
  };
}

function fixationRecord(fp?: string): FixationRecord {
  return {
    intentHash: HASH,
    canonical: "sales.trend",
    structureHash: "sha256:" + "1".repeat(64),
    pinnedSpec: validPinnedSpec(),
    fixatedAt: "2026-07-01T00:00:00Z",
    approver: { id: "tester" },
    ...(fp != null ? { catalogFingerprint: fp } : {}),
  };
}

function fixationRecordWithRevision(revision: string): FixationRecord {
  return { ...fixationRecord(), revision };
}

function harness(initial: FixationRecord) {
  const fixations = new Map<string, FixationRecord>([[initial.intentHash, initial]]);
  const recorded: string[] = [];
  const storage = {
    async getFixation(intentHash: string) {
      return fixations.get(intentHash) ?? null;
    },
    async putFixation(record: FixationRecord) {
      fixations.set(record.intentHash, record);
    },
    async deleteFixation(intentHash: string) {
      fixations.delete(intentHash);
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
    record: async (type: string) => {
      recorded.push(type);
    },
  } as unknown as Parameters<typeof createFixations>[0]["lineage"];
  return { api: createFixations({ lineage, storage }), fixations, recorded };
}

describe("Fixations.invalidate conditional deletion (TOCTOU guard)", () => {
  it("if the guard fingerprint differs from the current fixation, neither deletes nor audits (protects a re-approved one)", async () => {
    const { api, fixations, recorded } = harness(fixationRecord("fp-new"));
    await api.invalidate(HASH, "stale", {
      guard: { ifCatalogFingerprint: "fp-old" },
    });
    expect(fixations.has(HASH)).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("if the guard fingerprint matches, deletes the fixation and records intent.unfixated", async () => {
    const { api, fixations, recorded } = harness(fixationRecord("fp-old"));
    await api.invalidate(HASH, "stale", {
      detail: "validation failed",
      guard: { ifCatalogFingerprint: "fp-old" },
    });
    expect(fixations.has(HASH)).toBe(false);
    expect(recorded).toEqual(["intent.unfixated"]);
  });

  it("no guard means unconditional deletion (backward compatible)", async () => {
    const { api, fixations, recorded } = harness(fixationRecord("fp-any"));
    await api.invalidate(HASH, "stale");
    expect(fixations.has(HASH)).toBe(false);
    expect(recorded).toEqual(["intent.unfixated"]);
  });

  it("ifFixatedAt mismatch (re-approved legacy record without fingerprint) does not delete", async () => {
    // No catalogFingerprint at all (a legacy record) — only ifFixatedAt is available as a guard.
    const record = fixationRecord();
    const { api, fixations, recorded } = harness({ ...record, fixatedAt: "2026-08-01T00:00:00Z" });
    await api.invalidate(HASH, "stale", {
      guard: { ifFixatedAt: "2026-07-01T00:00:00Z" },
    });
    expect(fixations.has(HASH)).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("ifFixatedAt match deletes", async () => {
    const record = fixationRecord();
    const { api, fixations, recorded } = harness(record);
    await api.invalidate(HASH, "stale", {
      guard: { ifFixatedAt: record.fixatedAt },
    });
    expect(fixations.has(HASH)).toBe(false);
    expect(recorded).toEqual(["intent.unfixated"]);
  });

  // revision is a monotonic per-write token, finer-grained than fixatedAt's ms-precision ISO timestamp —
  // it distinguishes an unfixate -> fixate pair that lands inside the same millisecond, which ifFixatedAt
  // alone cannot. When present, ifRevision takes priority over ifFixatedAt in the guard check.
  it("ifRevision mismatch (re-approved within the same fixatedAt millisecond) does not delete, even if ifFixatedAt matches", async () => {
    const record = fixationRecordWithRevision("rev-old");
    // Same fixatedAt as the judged fixation (same-ms unfixate->fixate), but a fresh revision.
    const current = { ...record, revision: "rev-new" };
    const { api, fixations, recorded } = harness(current);
    await api.invalidate(HASH, "stale", {
      guard: { ifRevision: "rev-old", ifFixatedAt: record.fixatedAt },
    });
    expect(fixations.has(HASH)).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it("ifRevision match deletes", async () => {
    const record = fixationRecordWithRevision("rev-1");
    const { api, fixations, recorded } = harness(record);
    await api.invalidate(HASH, "stale", {
      guard: { ifRevision: "rev-1", ifFixatedAt: record.fixatedAt },
    });
    expect(fixations.has(HASH)).toBe(false);
    expect(recorded).toEqual(["intent.unfixated"]);
  });

  it("no ifRevision in the guard falls back to checking ifFixatedAt (records that predate revision)", async () => {
    const record = fixationRecord(); // no revision field at all (a legacy record)
    const { api, fixations, recorded } = harness(record);
    await api.invalidate(HASH, "stale", {
      guard: { ifFixatedAt: record.fixatedAt },
    });
    expect(fixations.has(HASH)).toBe(false);
    expect(recorded).toEqual(["intent.unfixated"]);
  });
});
