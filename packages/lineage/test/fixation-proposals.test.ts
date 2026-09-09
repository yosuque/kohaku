import type { FixationRecord, LineageEventRecord, StoragePort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createFixations, createLineage } from "../src/index.js";

/**
 * Direct unit coverage for Fixations.proposals' threshold logic (minUses / minDistinctSessions /
 * structuralStability, the L1-only tier filter, and the already-fixated exclusion). Guards
 * aggregateL1Usage (extracted to module scope from fixation/service.ts) against silently changing
 * threshold behavior; lineage.test.ts's tenant-scope test and host-rest/sample-api fixtures only
 * exercise this indirectly.
 */

function memoryStorage(): StoragePort & {
  events: LineageEventRecord[];
  fixed: FixationRecord[];
} {
  const events: LineageEventRecord[] = [];
  const fixed: FixationRecord[] = [];
  return {
    events,
    fixed,
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
    async getPromotionState() {
      return null;
    },
    async putPromotionState() {},
    async listPromotionStates() {
      return [];
    },
    async getFixation(h) {
      return fixed.find((f) => f.intentHash === h) ?? null;
    },
    async putFixation(rec) {
      fixed.push(rec);
    },
    async listFixations() {
      return fixed;
    },
  };
}

/** Builds a view.composed lineage event for proposals() aggregation. */
let composedSeq = 0;

function composed(args: {
  intentHash: string;
  tier?: "L0" | "L1" | "L2";
  sessionId?: string;
  structureHash?: string;
  canonical?: string;
}): LineageEventRecord {
  const { intentHash, tier = "L1", sessionId, structureHash, canonical = "sales.trend" } = args;
  return {
    id: `c-${intentHash}-${sessionId ?? ""}-${structureHash ?? ""}-${++composedSeq}`,
    ts: new Date().toISOString(),
    actor: { kind: "system" },
    type: "view.composed",
    payload: {
      tier,
      intentHash,
      canonical,
      ...(sessionId != null ? { sessionId } : {}),
      ...(structureHash != null ? { structureHash } : {}),
    },
  };
}

describe("Fixations.proposals の閾値ロジック(直接ユニットテスト)", () => {
  const policy = { minUses: 3, minDistinctSessions: 2, structuralStability: 0.9 };

  it("uses / sessions / stability の全閾値を満たせば候補化する", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, policy });
    // 3 uses across 2 sessions, all with the same structureHash (stability = 1.0).
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st1" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st1" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s2", structureHash: "st1" }));

    const proposals = await fixations.proposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      intentHash: "hA",
      canonical: "sales.trend",
      uses: 3,
      sessions: 2,
      stability: 1,
      tier: "L1",
    });
  });

  it("uses が閾値未満なら候補化しない", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, policy });
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st1" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s2", structureHash: "st1" }));

    expect(await fixations.proposals()).toEqual([]);
  });

  it("distinct session 数が閾値未満なら uses を満たしても候補化しない", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, policy });
    // 3 uses, but all in the same session (sessions=1 < minDistinctSessions=2).
    for (let i = 0; i < 3; i++) {
      await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st1" }));
    }

    expect(await fixations.proposals()).toEqual([]);
  });

  it("構造安定性(structuralStability)が閾値未満なら候補化しない", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, policy });
    // 4 uses / 2 sessions, but the structureHash splits roughly 50/50 (stability ~0.5 < 0.9).
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st1" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st2" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s2", structureHash: "st1" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s2", structureHash: "st2" }));

    expect(await fixations.proposals()).toEqual([]);
  });

  it("L1 以外の tier(L0/L2)は集計対象から除外する", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, policy });
    for (const tier of ["L0", "L2"] as const) {
      await storage.appendLineage(
        composed({ intentHash: "hL", tier, sessionId: "s1", structureHash: "st1" }),
      );
      await storage.appendLineage(
        composed({ intentHash: "hL", tier, sessionId: "s2", structureHash: "st1" }),
      );
      await storage.appendLineage(
        composed({ intentHash: "hL", tier, sessionId: "s3", structureHash: "st1" }),
      );
    }

    expect(await fixations.proposals()).toEqual([]);
  });

  it("既に固定化済みの intentHash は閾値を満たしても候補から除外する", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, policy });
    await storage.putFixation({
      intentHash: "hA",
      canonical: "sales.trend",
      structureHash: "st1",
      pinnedSpec: {} as never,
      fixatedAt: new Date().toISOString(),
      approver: { id: "admin" },
    });
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st1" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s1", structureHash: "st1" }));
    await storage.appendLineage(composed({ intentHash: "hA", sessionId: "s2", structureHash: "st1" }));

    expect(await fixations.proposals()).toEqual([]);
  });

  it("候補は uses 降順でソートされる", async () => {
    const storage = memoryStorage();
    const fixations = createFixations({ lineage: createLineage({ storage }), storage, policy });
    // hA: 3 uses. hB: 5 uses. Both satisfy all thresholds.
    for (let i = 0; i < 3; i++) {
      await storage.appendLineage(
        composed({ intentHash: "hA", sessionId: i % 2 === 0 ? "s1" : "s2", structureHash: "st1" }),
      );
    }
    for (let i = 0; i < 5; i++) {
      await storage.appendLineage(
        composed({ intentHash: "hB", sessionId: i % 2 === 0 ? "s3" : "s4", structureHash: "st1" }),
      );
    }

    const proposals = await fixations.proposals();
    expect(proposals.map((p) => p.intentHash)).toEqual(["hB", "hA"]);
  });
});
