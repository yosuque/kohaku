import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { LINEAGE_SCAN_CHUNK_SIZE } from "../src/lineage.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

function ev(seq: number, tenant: string): LineageEventRecord {
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    actor: { kind: "system" },
    type: "view.composed",
    payload: {},
    tenant,
  };
}

/**
 * `listLineage`'s two large-index read paths (findings #23): the limit-pushdown path for a filter the
 * chosen index alone satisfies, and the chunked scan (`LINEAGE_SCAN_CHUNK_SIZE`) for one it doesn't.
 * Seeds real data past the chunk boundary rather than mocking the client (see `backend.ts`), per the
 * plan's own resolution: "assert ... by seeding > limit events and checking the result".
 */
describe.skipIf(backend.mode === "skip")("createRedisStoragePort: lineage scan / pushdown", () => {
  let stop: () => Promise<void>;
  let port: RedisStoragePort;

  beforeAll(async () => {
    const started = await startRedis();
    stop = started.stop;
    port = createRedisStoragePort({ url: started.url, keyPrefix: uniquePrefix() });
  }, 120_000);

  afterAll(async () => {
    await port.close();
    await stop();
  });

  it("a filter fully expressed by its index (limit pushdown) reads only the newest `limit` events, in append order", async () => {
    const total = 20;
    for (let i = 0; i < total; i++) {
      await port.appendLineage(ev(i, "acme-pushdown"));
    }
    const limit = 3;
    // `{ tenant }` alone (no type/since/until/hash predicate) is fully expressed by the tenant index,
    // so this goes through `readPushdown`'s `ZREVRANGE idx 0 limit-1` instead of a chunked scan.
    const result = await port.listLineage({ tenant: "acme-pushdown", limit });
    expect(result.map((e) => e.id)).toEqual(
      Array.from({ length: limit }, (_, i) => ev(total - limit + i, "acme-pushdown").id),
    );
  }, 60_000);

  it("a filter not fully expressed by its index (tenant + since) scans the index in chunks past the chunk boundary", async () => {
    // More than one LINEAGE_SCAN_CHUNK_SIZE so the scan must continue into a second chunk before it
    // can conclude the index is exhausted (the first chunk alone contains far fewer than `limit`
    // matches, since only the newest few events satisfy `since`).
    const total = LINEAGE_SCAN_CHUNK_SIZE + 20;
    const matching = 5;
    for (let i = 0; i < total; i++) {
      await port.appendLineage(ev(i, "globex-scan"));
    }
    const since = ev(total - matching, "globex-scan").ts;
    // `{ tenant, since }`: the tenant index is the candidate, but `since` is a further predicate the
    // index doesn't express, so this goes through `scanForMatches`, not the pushdown path.
    const result = await port.listLineage({ tenant: "globex-scan", since });
    expect(result.map((e) => e.id)).toEqual(
      Array.from({ length: matching }, (_, i) => ev(total - matching + i, "globex-scan").id),
    );
  }, 60_000);
});
