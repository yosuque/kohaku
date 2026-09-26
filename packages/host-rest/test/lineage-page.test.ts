import type { ComposeContext } from "@kohaku-ui/composer";
import {
  type AuthzPort,
  type DomainPort,
  type LineageEventRecord,
  type LineageFilter,
  type LineagePage,
  type LineagePageRequest,
  matchesLineageFilter,
  pageLineageArray,
  type StoragePort,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// GET /lineage?order=asc&cursor=&pageSize= (design.md #53). The pre-existing (order-less) behavior is
// covered by lineage-since.test.ts / governance.test.ts and is untouched here.

const NO_COMPOSE = {} as unknown as ComposeContext;
const NO_AUTHZ = {} as unknown as AuthzPort;
const NO_DOMAIN = {} as unknown as DomainPort;

function ev(id: string, ts: string, payload: Record<string, unknown> = {}): LineageEventRecord {
  return { id, ts, actor: { kind: "system" }, type: "view.composed", payload };
}

/** A StoragePort backed by a plain array, using pageLineageArray for pageLineage (the same reference
 * implementation storage-memory uses) -- so this test exercises the real cursor/paging semantics, not a
 * hand-rolled stub. `withPageLineage: false` omits the method entirely (the NOT_IMPLEMENTED case). */
function arrayStorage(events: LineageEventRecord[], withPageLineage = true): StoragePort {
  const base: StoragePort = {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage(filter: LineageFilter = {}) {
      return events.filter((e) => matchesLineageFilter(e, filter));
    },
    async getPromotionState() {
      return null;
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
  if (!withPageLineage) return base;
  return {
    ...base,
    async pageLineage(req: LineagePageRequest): Promise<LineagePage> {
      return pageLineageArray(events, req);
    },
  };
}

function deps(storage: StoragePort): KohakuHostDeps {
  return {
    compose: { ...NO_COMPOSE, storage } as unknown as ComposeContext,
    domain: NO_DOMAIN,
    authz: NO_AUTHZ,
    querySource: "sales",
  };
}

describe("GET /lineage?order=asc (host-rest, design.md #53)", () => {
  it("returns {events, nextCursor} in ascending append order, paging through the whole log", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ev(`e${i}`, `2026-01-0${i + 1}T00:00:00.000Z`));
    const app = createKohakuRoutes(deps(arrayStorage(events)));

    const res1 = await app.request("/lineage?order=asc&pageSize=2");
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { events: LineageEventRecord[]; nextCursor?: string };
    expect(body1.events.map((e) => e.id)).toEqual(["e0", "e1"]);
    expect(body1.nextCursor).toBeDefined();

    const res2 = await app.request(
      `/lineage?order=asc&pageSize=2&cursor=${encodeURIComponent(body1.nextCursor!)}`,
    );
    const body2 = (await res2.json()) as { events: LineageEventRecord[]; nextCursor?: string };
    expect(body2.events.map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(body2.nextCursor).toBeDefined();

    const res3 = await app.request(
      `/lineage?order=asc&pageSize=2&cursor=${encodeURIComponent(body2.nextCursor!)}`,
    );
    const body3 = (await res3.json()) as { events: LineageEventRecord[]; nextCursor?: string };
    expect(body3.events.map((e) => e.id)).toEqual(["e4"]);
    expect(body3.nextCursor).toBeUndefined();
  });

  it("the default (order-less) /lineage response shape is unchanged: only {events}, no nextCursor key", async () => {
    const events = [ev("e0", "2026-01-01T00:00:00.000Z")];
    const app = createKohakuRoutes(deps(arrayStorage(events)));
    const res = await app.request("/lineage");
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["events"]);
  });

  it("combines order=asc with correlationId", async () => {
    const events = [
      ev("e0", "2026-01-01T00:00:00.000Z", { correlationId: "c1" }),
      ev("e1", "2026-01-02T00:00:00.000Z", { correlationId: "other" }),
      ev("e2", "2026-01-03T00:00:00.000Z", { correlationId: "c1" }),
    ];
    const app = createKohakuRoutes(deps(arrayStorage(events)));
    const res = await app.request("/lineage?order=asc&correlationId=c1");
    const body = (await res.json()) as { events: LineageEventRecord[] };
    expect(body.events.map((e) => e.id)).toEqual(["e0", "e2"]);
  });

  it("the default (order-less) /lineage also honours correlationId", async () => {
    const events = [
      ev("e0", "2026-01-01T00:00:00.000Z", { correlationId: "c1" }),
      ev("e1", "2026-01-02T00:00:00.000Z", { correlationId: "other" }),
    ];
    const app = createKohakuRoutes(deps(arrayStorage(events)));
    const res = await app.request("/lineage?correlationId=c1");
    const body = (await res.json()) as { events: LineageEventRecord[] };
    expect(body.events.map((e) => e.id)).toEqual(["e0"]);
  });

  it("501 NOT_IMPLEMENTED when the storage backend has no pageLineage", async () => {
    const app = createKohakuRoutes(deps(arrayStorage([ev("e0", "2026-01-01T00:00:00.000Z")], false)));
    const res = await app.request("/lineage?order=asc");
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_IMPLEMENTED");
  });

  it("400 BAD_REQUEST for an order value other than asc", async () => {
    const app = createKohakuRoutes(deps(arrayStorage([])));
    const res = await app.request("/lineage?order=desc");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("400 BAD_REQUEST for a malformed cursor", async () => {
    const app = createKohakuRoutes(deps(arrayStorage([ev("e0", "2026-01-01T00:00:00.000Z")])));
    const res = await app.request("/lineage?order=asc&cursor=not-a-real-cursor");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});
