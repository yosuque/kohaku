import {
  encodeSeqCursor,
  type FixationRecord,
  type LineageEventRecord,
  type PromotionState,
  type StoragePort,
  type UISpec,
} from "@kohaku-ui/spec-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

export interface ContractFixture<P> {
  port: P;
  dispose?: () => Promise<void> | void;
}

export interface StorageContractOptions {
  /**
   * "fake" (default): TTL tests drive vi.useFakeTimers / vi.setSystemTime. "real": the store's TTL is
   * server-side (e.g. redis EXPIRE), so the suite waits ~1.1s of wall clock instead of moving the clock.
   */
  clock?: "fake" | "real";
  /**
   * When true, `pageLineage` (StoragePort's optional forward-paging extension, design.md #53) MUST be
   * implemented -- the suite fails if it is missing, instead of silently skipping the paging tests the
   * way an adapter that omits any other optional extension (`deleteFixation`, `putPromotionStates`) does.
   * Default false (paging tests run only when `port.pageLineage` happens to exist, and are a no-op
   * otherwise).
   */
  requirePaging?: boolean;
}

function spec(id: string): UISpec {
  return { key: id } as unknown as UISpec;
}

function fixation(intentHash: string, tenant?: string, revision?: string): FixationRecord {
  return {
    intentHash,
    canonical: "contract.intent",
    structureHash: "sha256:contract",
    pinnedSpec: spec(intentHash),
    fixatedAt: "2026-01-01T00:00:00.000Z",
    approver: { id: "contract" },
    ...(tenant != null ? { tenant } : {}),
    ...(revision != null ? { revision } : {}),
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
    id: `${type}:${ts}:${tenant ?? ""}`,
    ts,
    actor: { kind: "system" },
    type,
    payload,
    ...(tenant != null ? { tenant } : {}),
  };
}

async function advance(clock: "fake" | "real", ms: number): Promise<void> {
  if (clock === "fake") {
    vi.setSystemTime(new Date(Date.now() + ms));
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The StoragePort contract every adapter must satisfy (spec-core ports.ts). Registers one `describe` block;
 * call it at the top level of a vitest file. `factory` runs before each test so tests never share state.
 */
export function describeStoragePortContract(
  name: string,
  factory: () => Promise<ContractFixture<StoragePort>> | ContractFixture<StoragePort>,
  options: StorageContractOptions = {},
): void {
  const clock = options.clock ?? "fake";

  describe(`StoragePort contract: ${name}`, () => {
    let fixture: ContractFixture<StoragePort>;
    let port: StoragePort;

    beforeEach(async () => {
      if (clock === "fake") {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      }
      fixture = await factory();
      port = fixture.port;
    });

    afterEach(async () => {
      await fixture.dispose?.();
      if (clock === "fake") vi.useRealTimers();
    });

    describe("spec cache", () => {
      it("misses an unknown key and hits a stored one", async () => {
        expect(await port.getSpecCache("missing")).toBeNull();
        await port.putSpecCache("k", spec("a"));
        expect(await port.getSpecCache("k")).toEqual(spec("a"));
      });

      it("overwrites on put with the same key", async () => {
        await port.putSpecCache("k", spec("a"));
        await port.putSpecCache("k", spec("b"));
        expect(await port.getSpecCache("k")).toEqual(spec("b"));
      });

      it("expires an entry once ttlSeconds has elapsed", async () => {
        await port.putSpecCache("k", spec("a"), 1);
        expect(await port.getSpecCache("k")).toEqual(spec("a"));
        await advance(clock, 1100);
        expect(await port.getSpecCache("k")).toBeNull();
      });
    });

    describe("lineage", () => {
      const e1 = event(
        "view.composed",
        { intentHash: "h1", artifactId: "a1", specHash: "s1", correlationId: "c1" },
        "2026-01-01T00:00:00.000Z",
        "t1",
      );
      const e2 = event(
        "view.composed",
        { intentHash: "h2", artifactId: "a2", specHash: "s2", correlationId: "c2" },
        "2026-01-02T00:00:00.000Z",
        "t2",
      );
      const e3 = event(
        "component.used",
        { intentHash: "h1", artifactId: "a1", specHash: "s1", correlationId: "c1" },
        "2026-01-03T00:00:00.000Z",
        "t1",
      );

      beforeEach(async () => {
        await port.appendLineage(e1);
        await port.appendLineage(e2);
        await port.appendLineage(e3);
      });

      it("lists in append order without a filter", async () => {
        expect((await port.listLineage()).map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
      });

      it("filters by type, tenant, intentHash, artifactId, specHash", async () => {
        expect((await port.listLineage({ type: ["component.used"] })).map((e) => e.id)).toEqual([e3.id]);
        expect((await port.listLineage({ tenant: "t1" })).map((e) => e.id)).toEqual([e1.id, e3.id]);
        expect((await port.listLineage({ intentHash: "h2" })).map((e) => e.id)).toEqual([e2.id]);
        expect((await port.listLineage({ artifactId: "a2" })).map((e) => e.id)).toEqual([e2.id]);
        expect((await port.listLineage({ specHash: "s1" })).map((e) => e.id)).toEqual([e1.id, e3.id]);
        expect((await port.listLineage({ correlationId: "c1" })).map((e) => e.id)).toEqual([e1.id, e3.id]);
      });

      it("applies since / until inclusively and limit as a tail window; limit <= 0 is empty", async () => {
        expect((await port.listLineage({ since: "2026-01-02T00:00:00.000Z" })).map((e) => e.id)).toEqual([
          e2.id,
          e3.id,
        ]);
        expect((await port.listLineage({ until: "2026-01-02T00:00:00.000Z" })).map((e) => e.id)).toEqual([
          e1.id,
          e2.id,
        ]);
        expect((await port.listLineage({ limit: 2 })).map((e) => e.id)).toEqual([e2.id, e3.id]);
        expect(await port.listLineage({ limit: 0 })).toEqual([]);
        expect(await port.listLineage({ limit: -1 })).toEqual([]);
      });

      it("treats an empty-string tenant filter as unspecified (matches every event)", async () => {
        expect((await port.listLineage({ tenant: "" })).map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
      });

      it("appending an event with an id that already exists is idempotent", async () => {
        await port.appendLineage({ ...e1, payload: { ...e1.payload, specHash: "mutated" } });
        const all = await port.listLineage();
        expect(all.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
        expect(all.find((e) => e.id === e1.id)?.payload["specHash"]).toBe("s1");
      });
    });

    describe("pageLineage (optional forward-paging extension, design.md #53)", () => {
      it("is implemented when this suite requires it", () => {
        if (options.requirePaging === true) {
          expect(port.pageLineage).toBeTypeOf("function");
        }
      });

      const p1 = event(
        "view.composed",
        { intentHash: "h1", correlationId: "c1" },
        "2026-01-01T00:00:00.000Z",
        "t1",
      );
      const p2 = event(
        "view.composed",
        { intentHash: "h2", correlationId: "c2" },
        "2026-01-02T00:00:00.000Z",
        "t2",
      );
      const p3 = event(
        "component.used",
        { intentHash: "h3", correlationId: "c1" },
        "2026-01-03T00:00:00.000Z",
        "t1",
      );
      const p4 = event(
        "view.composed",
        { intentHash: "h4", correlationId: "c3" },
        "2026-01-04T00:00:00.000Z",
        "t1",
      );

      beforeEach(async () => {
        await port.appendLineage(p1);
        await port.appendLineage(p2);
        await port.appendLineage(p3);
        await port.appendLineage(p4);
      });

      it("returns pages in ascending append order with no gaps or duplicates", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        const page1 = await port.pageLineage({ pageSize: 2 });
        expect(page1.events.map((e) => e.id)).toEqual([p1.id, p2.id]);
        expect(page1.nextCursor).toBeDefined();
        const page2 = await port.pageLineage({ pageSize: 2, cursor: page1.nextCursor });
        expect(page2.events.map((e) => e.id)).toEqual([p3.id, p4.id]);
        expect(page2.nextCursor).toBeUndefined();
      });

      it("an event appended between two page reads is visible on a later page without disturbing earlier ones", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        const page1 = await port.pageLineage({ pageSize: 3 });
        expect(page1.events.map((e) => e.id)).toEqual([p1.id, p2.id, p3.id]);
        expect(page1.nextCursor).toBeDefined();
        const p5 = event("view.composed", { intentHash: "h5" }, "2026-01-05T00:00:00.000Z");
        await port.appendLineage(p5);
        const page2 = await port.pageLineage({ pageSize: 3, cursor: page1.nextCursor });
        expect(page2.events.map((e) => e.id)).toEqual([p4.id, p5.id]);
        expect(page2.nextCursor).toBeUndefined();
      });

      it("combines with a filter predicate (correlationId)", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        const page = await port.pageLineage({ correlationId: "c1" });
        expect(page.events.map((e) => e.id)).toEqual([p1.id, p3.id]);
        expect(page.nextCursor).toBeUndefined();
      });

      it("combines with the tenant filter", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        const page = await port.pageLineage({ tenant: "t1" });
        expect(page.events.map((e) => e.id)).toEqual([p1.id, p3.id, p4.id]);
      });

      it("truncates an oversized pageSize to the 1000 cap instead of rejecting it", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        const page = await port.pageLineage({ pageSize: 1_000_000 });
        expect(page.events).toHaveLength(4);
        expect(page.nextCursor).toBeUndefined();
      });

      it("floors a fractional pageSize to an integer", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        const page = await port.pageLineage({ pageSize: 2.5 });
        expect(page.events).toHaveLength(2);
        expect(page.nextCursor).toBeDefined();
      });

      it("throws for a malformed cursor instead of restarting or skipping silently", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        await expect(port.pageLineage({ cursor: "not-a-real-cursor" })).rejects.toThrow();
      });

      it("rejects a well-formed cursor whose seq is fractional, negative or beyond the safe-integer range", async () => {
        if (port.pageLineage == null) return; // optional extension not implemented
        for (const seq of [0.5, -1, 2 ** 53, 1e300]) {
          await expect(port.pageLineage({ cursor: encodeSeqCursor(seq) })).rejects.toThrow();
        }
      });
    });

    describe("promotion states", () => {
      it("keys by (tenant, artifactId): tenant-less and tenant-scoped states do not collide", async () => {
        await port.putPromotionState(promotion("x"));
        await port.putPromotionState(promotion("x", "a"));
        expect(await port.getPromotionState("x")).toEqual(promotion("x"));
        expect(await port.getPromotionState("x", "a")).toEqual(promotion("x", "a"));
        expect(await port.getPromotionState("x", "b")).toBeNull();
      });

      it("overwrites on put and lists per tenant (unspecified tenant = all)", async () => {
        await port.putPromotionState(promotion("x", "a"));
        await port.putPromotionState({ ...promotion("x", "a"), status: "approved" });
        await port.putPromotionState(promotion("y", "b"));
        expect((await port.getPromotionState("x", "a"))?.status).toBe("approved");
        expect((await port.listPromotionStates("a")).map((s) => s.artifactId)).toEqual(["x"]);
        expect((await port.listPromotionStates()).map((s) => s.artifactId).sort()).toEqual(["x", "y"]);
      });

      it("putPromotionStates (optional) is equivalent to putting each state", async () => {
        if (port.putPromotionStates == null) return; // optional extension not implemented
        await port.putPromotionStates([promotion("x", "a"), promotion("y", "a")]);
        expect((await port.listPromotionStates("a")).map((s) => s.artifactId).sort()).toEqual(["x", "y"]);
      });

      it("treats an empty-string tenant as equivalent to unspecified for get/put/list", async () => {
        await port.putPromotionState(promotion("x", ""));
        expect(await port.getPromotionState("x")).toEqual(promotion("x", ""));
        expect(await port.getPromotionState("x", "")).toEqual(promotion("x", ""));
        expect((await port.listPromotionStates("")).map((s) => s.artifactId)).toEqual(
          (await port.listPromotionStates()).map((s) => s.artifactId),
        );
      });
    });

    describe("fixations", () => {
      it("keys by (tenant, intentHash) and lists per tenant", async () => {
        await port.putFixation(fixation("h"));
        await port.putFixation(fixation("h", "a"));
        expect(await port.getFixation("h")).toEqual(fixation("h"));
        expect(await port.getFixation("h", "a")).toEqual(fixation("h", "a"));
        expect(await port.getFixation("h", "b")).toBeNull();
        expect((await port.listFixations("a")).map((f) => f.intentHash)).toEqual(["h"]);
        expect(await port.listFixations()).toHaveLength(2);
      });

      it("ifPresent updates an existing record and never creates one", async () => {
        await port.putFixation(fixation("h", "a"), { ifPresent: true });
        expect(await port.getFixation("h", "a")).toBeNull();
        await port.putFixation(fixation("h", "a"));
        await port.putFixation(fixation("h", "a", "2"), { ifPresent: true });
        expect((await port.getFixation("h", "a"))?.revision).toBe("2");
      });

      it("deleteFixation (optional) removes only that (tenant, intentHash)", async () => {
        if (port.deleteFixation == null) return; // optional extension not implemented
        await port.putFixation(fixation("h", "a"));
        await port.putFixation(fixation("h", "b"));
        await port.deleteFixation("h", "a");
        expect(await port.getFixation("h", "a")).toBeNull();
        expect(await port.getFixation("h", "b")).not.toBeNull();
      });

      it("treats an empty-string tenant as equivalent to unspecified for get/put/list", async () => {
        await port.putFixation(fixation("h", ""));
        expect(await port.getFixation("h")).toEqual(fixation("h", ""));
        expect(await port.getFixation("h", "")).toEqual(fixation("h", ""));
        expect((await port.listFixations("")).map((f) => f.intentHash)).toEqual(
          (await port.listFixations()).map((f) => f.intentHash),
        );
      });
    });
  });
}
