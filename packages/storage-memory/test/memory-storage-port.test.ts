import type { FixationRecord, LineageEventRecord, PromotionState, UISpec } from "@kohaku-ui/spec-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStoragePort, MAX_SPEC_CACHE_ENTRIES } from "../src/index.js";

function fakeSpec(id: string): UISpec {
  return { key: id } as unknown as UISpec;
}

function fixation(intentHash: string, tenant?: string): FixationRecord {
  return {
    intentHash,
    canonical: "sales.trend",
    structureHash: "sha256:st",
    pinnedSpec: fakeSpec(intentHash),
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "admin" },
    ...(tenant != null ? { tenant } : {}),
  };
}

function promotion(artifactId: string, tenant?: string): PromotionState {
  return {
    artifactId,
    status: "candidate",
    updatedAt: "2026-01-01T00:00:00.000Z",
    data: {},
    ...(tenant != null ? { tenant } : {}),
  };
}

function event(
  type: string,
  payload: Record<string, unknown>,
  ts: string,
  tenant?: string,
): LineageEventRecord {
  return {
    id: `${type}:${ts}`,
    ts,
    actor: { kind: "system" },
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

describe("createMemoryStoragePort: spec cache", () => {
  afterEach(() => vi.useRealTimers());

  it("returns null for a miss and the stored spec for a hit", async () => {
    const storage = createMemoryStoragePort();
    expect(await storage.getSpecCache("k")).toBeNull();
    await storage.putSpecCache("k", fakeSpec("a"));
    expect(await storage.getSpecCache("k")).toEqual(fakeSpec("a"));
  });

  it("expires an entry after ttlSeconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const storage = createMemoryStoragePort();
    await storage.putSpecCache("k", fakeSpec("a"), 1);
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    expect(await storage.getSpecCache("k")).toBeNull();
  });

  it("evicts the least recently used entry beyond MAX_SPEC_CACHE_ENTRIES", async () => {
    const storage = createMemoryStoragePort();
    for (let i = 0; i < MAX_SPEC_CACHE_ENTRIES; i++) await storage.putSpecCache(`k${i}`, fakeSpec(`k${i}`));
    // Touch k0 so it becomes the most recently used; k1 is now the oldest.
    await storage.getSpecCache("k0");
    await storage.putSpecCache("overflow", fakeSpec("overflow"));
    expect(await storage.getSpecCache("k0")).not.toBeNull();
    expect(await storage.getSpecCache("k1")).toBeNull();
  });
});

describe("createMemoryStoragePort: lineage", () => {
  it("lists in append order, filtered by type / tenant / intentHash / since / until, tail-limited", async () => {
    const storage = createMemoryStoragePort();
    await storage.appendLineage(
      event("view.composed", { intentHash: "h1" }, "2026-01-01T00:00:00.000Z", "a"),
    );
    await storage.appendLineage(
      event("view.composed", { intentHash: "h2" }, "2026-01-02T00:00:00.000Z", "b"),
    );
    await storage.appendLineage(
      event("component.used", { intentHash: "h1" }, "2026-01-03T00:00:00.000Z", "a"),
    );

    expect((await storage.listLineage()).map((e) => e.ts)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "2026-01-03T00:00:00.000Z",
    ]);
    expect(await storage.listLineage({ type: ["component.used"] })).toHaveLength(1);
    expect(await storage.listLineage({ tenant: "a" })).toHaveLength(2);
    expect(await storage.listLineage({ intentHash: "h2" })).toHaveLength(1);
    expect(await storage.listLineage({ since: "2026-01-02T00:00:00.000Z" })).toHaveLength(2);
    expect(await storage.listLineage({ until: "2026-01-02T00:00:00.000Z" })).toHaveLength(2);
    expect((await storage.listLineage({ limit: 1 }))[0]!.ts).toBe("2026-01-03T00:00:00.000Z");
    expect(await storage.listLineage({ limit: 0 })).toEqual([]);
  });
});

describe("createMemoryStoragePort: promotion states", () => {
  it("separates states by (tenant, artifactId) and lists per tenant", async () => {
    const storage = createMemoryStoragePort();
    await storage.putPromotionState(promotion("x"));
    await storage.putPromotionState(promotion("x", "a"));
    await storage.putPromotionStates!([promotion("y", "a"), promotion("z", "b")]);
    expect(await storage.getPromotionState("x")).toEqual(promotion("x"));
    expect(await storage.getPromotionState("x", "a")).toEqual(promotion("x", "a"));
    expect(await storage.getPromotionState("x", "b")).toBeNull();
    expect((await storage.listPromotionStates("a")).map((s) => s.artifactId).sort()).toEqual(["x", "y"]);
    expect(await storage.listPromotionStates()).toHaveLength(4);
  });
});

describe("createMemoryStoragePort: fixations", () => {
  it("separates fixations by (tenant, intentHash), deletes, and honors ifPresent", async () => {
    const storage = createMemoryStoragePort();
    await storage.putFixation(fixation("h", "a"));
    expect(await storage.getFixation("h", "a")).toEqual(fixation("h", "a"));
    expect(await storage.getFixation("h", "b")).toBeNull();
    expect(await storage.listFixations("a")).toHaveLength(1);
    expect(await storage.listFixations("b")).toHaveLength(0);

    await storage.deleteFixation!("h", "a");
    expect(await storage.getFixation("h", "a")).toBeNull();

    // ifPresent must not resurrect a deleted record.
    await storage.putFixation(fixation("h", "a"), { ifPresent: true });
    expect(await storage.getFixation("h", "a")).toBeNull();
    await storage.putFixation(fixation("h", "a"));
    await storage.putFixation({ ...fixation("h", "a"), revision: "2" }, { ifPresent: true });
    expect((await storage.getFixation("h", "a"))?.revision).toBe("2");
  });
});
