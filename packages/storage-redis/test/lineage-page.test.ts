import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { LINEAGE_SCAN_CHUNK_SIZE } from "../src/lineage.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

function ev(seq: number, extra: Partial<LineageEventRecord> = {}): LineageEventRecord {
  return {
    id: `e${String(seq).padStart(5, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    actor: { kind: "system" },
    type: "view.composed",
    payload: {},
    ...extra,
  };
}

/**
 * `StoragePort.pageLineage` (design.md #53) against a real Redis, including a scan that crosses
 * `LINEAGE_SCAN_CHUNK_SIZE` (`readLineagePage`'s own chunked `ZRANGEBYSCORE` read) more than once in a
 * single call -- the shared contract suite (contract.test.ts, requirePaging: true) exercises the
 * ascending/append/filter/cursor semantics with a handful of events, so this file's own job is only the
 * multi-chunk continuation path a handful of events can't reach.
 *
 * Each test gets its own `RedisStoragePort` (a fresh `uniquePrefix()` keyspace) so that events from one
 * test can never collide, by id, with another's -- the container itself is still resolved once for the
 * whole file (module-level memoized, mirroring contract.test.ts) since starting one per test would cost
 * minutes of wall clock across this file's large event counts.
 */
describe.skipIf(backend.mode === "skip")("createRedisStoragePort: pageLineage", () => {
  let started: Awaited<ReturnType<typeof startRedis>> | undefined;
  let port: RedisStoragePort | undefined;

  async function freshPort(): Promise<RedisStoragePort> {
    started ??= await startRedis();
    port = createRedisStoragePort({ url: started.url, keyPrefix: uniquePrefix() });
    return port;
  }

  afterEach(async () => {
    await port?.close();
    port = undefined;
  });

  afterAll(async () => {
    await started?.stop();
    started = undefined;
  });

  it("continues scanning across more than one LINEAGE_SCAN_CHUNK_SIZE chunk within a single page", async () => {
    const p = await freshPort();
    const total = LINEAGE_SCAN_CHUNK_SIZE * 2 + 5;
    for (let i = 0; i < total; i++) {
      // Only the very last event matches; every chunk before it must be scanned and discarded.
      await p.appendLineage(
        ev(i, { tenant: "chunked", payload: i === total - 1 ? { correlationId: "only-match" } : {} }),
      );
    }
    const page = await p.pageLineage!({ tenant: "chunked", correlationId: "only-match" });
    expect(page.events.map((e) => e.id)).toEqual([ev(total - 1).id]);
    expect(page.nextCursor).toBeUndefined();
  }, 30_000);

  it("pages forward across a chunk boundary with no gaps or duplicates when unfiltered", async () => {
    const p = await freshPort();
    const total = LINEAGE_SCAN_CHUNK_SIZE + 10;
    for (let i = 0; i < total; i++) {
      await p.appendLineage(ev(i));
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await p.pageLineage!({ pageSize: 300, cursor });
      collected.push(...page.events.map((e) => e.id));
      if (page.nextCursor == null) break;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual(Array.from({ length: total }, (_, i) => ev(i).id));
  }, 30_000);

  it("throws for a malformed cursor", async () => {
    const p = await freshPort();
    await expect(p.pageLineage!({ cursor: "not-a-real-cursor" })).rejects.toThrow();
  });
});
