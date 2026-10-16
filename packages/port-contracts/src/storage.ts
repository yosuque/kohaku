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
   * Opts into the `pageLineage` cases (StoragePort's optional forward-paging extension, design.md #53).
   * Explicit rather than feature-detected (`port.pageLineage != null`): a guard like that turns every case
   * into a zero-assertion pass for a port that omits the method, which is indistinguishable from a real
   * pass in the report. When true, the port MUST implement the method (a port missing it fails the cases
   * instead of being skipped); when false or omitted, the cases are registered as skipped so the report
   * shows they did not run. The same pattern as `AuthzContractOptions.revocation`.
   */
  requirePaging?: boolean;
  /**
   * Opts into the `putPromotionStates` case (the optional batch write). Same explicit opt-in as
   * `requirePaging`: true makes the method mandatory, omitted shows the case as skipped.
   */
  requirePutPromotionStates?: boolean;
  /**
   * Opts into the `deleteFixation` case (the optional delete). Same explicit opt-in as `requirePaging`:
   * true makes the method mandatory, omitted shows the case as skipped.
   */
  requireDeleteFixation?: boolean;
}

/** The failure for a case whose optional StoragePort method the suite required but the port lacks. */
function missingExtension(method: string): Error {
  return new Error(
    `StoragePort.${method} is required by this suite's options but the port does not implement it`,
  );
}

/** `port.pageLineage`, bound to `port`, or a failure when the port does not implement it. */
function requirePageLineage(port: StoragePort): NonNullable<StoragePort["pageLineage"]> {
  const pageLineage = port.pageLineage;
  if (pageLineage == null) throw missingExtension("pageLineage");
  return pageLineage.bind(port);
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
  // Each optional extension's cases are registered but skipped unless the caller opted in, so a skipped
  // case is visible in the report instead of passing without a single assertion.
  const pagingIt = it.skipIf(options.requirePaging !== true);
  const putPromotionStatesIt = it.skipIf(options.requirePutPromotionStates !== true);
  const deleteFixationIt = it.skipIf(options.requireDeleteFixation !== true);

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

    describe("oversized correlationId", () => {
      it("appendLineage succeeds for a 4 KB correlationId, which stays filterable and unmodified", async () => {
        const long = `req-${"x".repeat(4096)}`;
        const other = `${long}y`;
        const withLong = event("view.render", { correlationId: long }, "2026-01-05T00:00:00.000Z");
        const withOther = event("view.render", { correlationId: other }, "2026-01-05T00:00:01.000Z");
        await port.appendLineage(withLong);
        await port.appendLineage(withOther);
        const listed = await port.listLineage({ correlationId: long });
        expect(listed.map((e) => e.id)).toEqual([withLong.id]);
        expect(listed[0]?.payload["correlationId"]).toBe(long);
        expect((await port.listLineage({ correlationId: other })).map((e) => e.id)).toEqual([withOther.id]);
        if (options.requirePaging === true) {
          const page = await requirePageLineage(port)({ correlationId: long });
          expect(page.events.map((e) => e.id)).toEqual([withLong.id]);
        }
      });
    });

    describe("pageLineage (optional forward-paging extension, design.md #53)", () => {
      pagingIt("is implemented by the port under test", () => {
        expect(port.pageLineage).toBeTypeOf("function");
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

      pagingIt("returns pages in ascending append order with no gaps or duplicates", async () => {
        const pageLineage = requirePageLineage(port);
        const page1 = await pageLineage({ pageSize: 2 });
        expect(page1.events.map((e) => e.id)).toEqual([p1.id, p2.id]);
        expect(page1.nextCursor).toBeDefined();
        const page2 = await pageLineage({ pageSize: 2, cursor: page1.nextCursor });
        expect(page2.events.map((e) => e.id)).toEqual([p3.id, p4.id]);
        expect(page2.nextCursor).toBeUndefined();
      });

      pagingIt(
        "an event appended between two page reads is visible on a later page without disturbing earlier ones",
        async () => {
          const pageLineage = requirePageLineage(port);
          const page1 = await pageLineage({ pageSize: 3 });
          expect(page1.events.map((e) => e.id)).toEqual([p1.id, p2.id, p3.id]);
          expect(page1.nextCursor).toBeDefined();
          const p5 = event("view.composed", { intentHash: "h5" }, "2026-01-05T00:00:00.000Z");
          await port.appendLineage(p5);
          const page2 = await pageLineage({ pageSize: 3, cursor: page1.nextCursor });
          expect(page2.events.map((e) => e.id)).toEqual([p4.id, p5.id]);
          expect(page2.nextCursor).toBeUndefined();
        },
      );

      pagingIt("combines with a filter predicate (correlationId)", async () => {
        const pageLineage = requirePageLineage(port);
        const page = await pageLineage({ correlationId: "c1" });
        expect(page.events.map((e) => e.id)).toEqual([p1.id, p3.id]);
        expect(page.nextCursor).toBeUndefined();
      });

      pagingIt("combines with the tenant filter", async () => {
        const pageLineage = requirePageLineage(port);
        const page = await pageLineage({ tenant: "t1" });
        expect(page.events.map((e) => e.id)).toEqual([p1.id, p3.id, p4.id]);
      });

      pagingIt("truncates an oversized pageSize to the 1000 cap instead of rejecting it", async () => {
        const pageLineage = requirePageLineage(port);
        const page = await pageLineage({ pageSize: 1_000_000 });
        expect(page.events).toHaveLength(4);
        expect(page.nextCursor).toBeUndefined();
      });

      pagingIt("floors a fractional pageSize to an integer", async () => {
        const pageLineage = requirePageLineage(port);
        const page = await pageLineage({ pageSize: 2.5 });
        expect(page.events).toHaveLength(2);
        expect(page.nextCursor).toBeDefined();
      });

      pagingIt("throws for a malformed cursor instead of restarting or skipping silently", async () => {
        const pageLineage = requirePageLineage(port);
        await expect(pageLineage({ cursor: "not-a-real-cursor" })).rejects.toThrow();
      });

      pagingIt(
        "rejects a well-formed cursor whose seq is fractional, negative or beyond the safe-integer range",
        async () => {
          const pageLineage = requirePageLineage(port);
          for (const seq of [0.5, -1, 2 ** 53, 1e300]) {
            await expect(pageLineage({ cursor: encodeSeqCursor(seq) })).rejects.toThrow();
          }
        },
      );
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

      putPromotionStatesIt("putPromotionStates (optional) is equivalent to putting each state", async () => {
        if (port.putPromotionStates == null) throw missingExtension("putPromotionStates");
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

      deleteFixationIt("deleteFixation (optional) removes only that (tenant, intentHash)", async () => {
        if (port.deleteFixation == null) throw missingExtension("deleteFixation");
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
