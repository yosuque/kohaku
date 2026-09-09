import type { ComposeContext } from "@kohaku-ui/composer";
import type {
  AuthzPort,
  DomainPort,
  LineageEventRecord,
  LineageFilter,
  StoragePort,
} from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps } from "../src/index.js";

// GET /lineage since validation / canonicalization:
// Only ISO8601 is accepted (non-ISO is 400 because Date.parse's local-TZ interpretation makes it environment-dependent).
// Since StoragePort compares since lexicographically, the accepted values (date-only, with TZ offset) are
// normalized to ISO8601 canonical form (UTC) on the route side before being passed to storage — this test verifies that.

const NO_COMPOSE = {} as unknown as ComposeContext;
const NO_AUTHZ = {} as unknown as AuthzPort;
const NO_DOMAIN = {} as unknown as DomainPort;

function ev(ts: string): LineageEventRecord {
  return { id: ts, ts, actor: { kind: "system" }, type: "view.composed", payload: {} };
}

/** A storage that compares since/until lexicographically (the implementation idiom). The passed filter can be peeked via onFilter. */
function lineageStorage(
  events: LineageEventRecord[],
  onFilter?: (filter: LineageFilter) => void,
): StoragePort {
  return {
    async getSpecCache() {
      return null;
    },
    async putSpecCache() {},
    async appendLineage() {},
    async listLineage(filter: LineageFilter = {}) {
      onFilter?.(filter);
      return events.filter(
        (e) =>
          (filter.since == null || e.ts >= filter.since) && (filter.until == null || e.ts <= filter.until),
      );
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
}

function deps(storage: StoragePort): KohakuHostDeps {
  return {
    compose: { ...NO_COMPOSE, storage } as unknown as ComposeContext,
    domain: NO_DOMAIN,
    authz: NO_AUTHZ,
    querySource: "sales",
  };
}

describe("since normalization in /lineage (host-rest)", () => {
  it("since is normalized to canonical ISO8601 at the route before being passed to storage", async () => {
    let seenSince: string | undefined;
    const app = createKohakuRoutes(deps(lineageStorage([], (f) => (seenSince = f.since))));

    const res = await app.request("/lineage?since=2026-07-09");
    expect(res.status).toBe(200);
    // Date-only ISO8601 is interpreted as UTC (ES spec), so it normalizes to canonical form independent of TZ.
    expect(seenSince).toBe("2026-07-09T00:00:00.000Z");
    // After normalization it is always canonical (zero-padded + T + milliseconds + Z).
    expect(seenSince).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("since with a TZ offset is normalized to the UTC canonical form and is not missed even under lexicographic comparison", async () => {
    // 12:00 at +09:00 is 03:00 UTC. Comparing the raw string lexicographically without normalization gives
    // "2026-07-09T05:00:00.000Z" < "2026-07-09T12:00:00+09:00" (lexicographically '0' < '1'),
    // which would miss the 05:00Z event that is after since. After normalization only 05:00Z is returned.
    const events = [ev("2026-07-09T02:00:00.000Z"), ev("2026-07-09T05:00:00.000Z")];
    const app = createKohakuRoutes(deps(lineageStorage(events)));

    const res = await app.request(`/lineage?since=${encodeURIComponent("2026-07-09T12:00:00+09:00")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: LineageEventRecord[] };
    expect(body.events.map((e) => e.ts)).toEqual(["2026-07-09T05:00:00.000Z"]);
  });

  it("non-ISO formats and time-bearing values without TZ are 400 BAD_REQUEST (Date.parse's local-TZ interpretation is not allowed)", async () => {
    const app = createKohakuRoutes(deps(lineageStorage([])));
    for (const bad of ["not-a-date", "2026-7-9", "July 9, 2026", "2026-07-09T12:00:00"]) {
      const res = await app.request(`/lineage?since=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
    }
  });
});

describe("until support in /lineage (readability-6, same normalization and boundary interpretation as /analytics)", () => {
  it("until is normalized to canonical ISO8601 at the route before being passed to storage", async () => {
    let seenUntil: string | undefined;
    const app = createKohakuRoutes(deps(lineageStorage([], (f) => (seenUntil = f.until))));

    const res = await app.request("/lineage?until=2026-07-09");
    expect(res.status).toBe(200);
    expect(seenUntil).toBe("2026-07-09T00:00:00.000Z");
  });

  it("until is inclusive of the boundary (ts <= until); TZ-offset values are also normalized to the UTC canonical form and not missed", async () => {
    // 14:00 at +09:00 is 05:00 UTC. With until=05:00Z, the boundary event (05:00Z) is included and later ones (06:00Z) are excluded.
    const events = [ev("2026-07-09T05:00:00.000Z"), ev("2026-07-09T06:00:00.000Z")];
    const app = createKohakuRoutes(deps(lineageStorage(events)));

    const res = await app.request(`/lineage?until=${encodeURIComponent("2026-07-09T14:00:00+09:00")}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: LineageEventRecord[] };
    expect(body.events.map((e) => e.ts)).toEqual(["2026-07-09T05:00:00.000Z"]);
  });

  it("non-ISO format until is 400 BAD_REQUEST", async () => {
    const app = createKohakuRoutes(deps(lineageStorage([])));
    const res = await app.request(`/lineage?until=${encodeURIComponent("July 9, 2026")}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});
