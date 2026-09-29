import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { redisKeys } from "../src/keys.js";
import { LINEAGE_SCAN_CHUNK_SIZE, readLineagePage } from "../src/lineage.js";
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
  const clients: Redis[] = [];

  /** A shared-client port plus that client, so a test can spy on the commands it issues. */
  async function spiedPort(): Promise<{ client: Redis; keyPrefix: string; p: RedisStoragePort }> {
    started ??= await startRedis();
    const client = new Redis(started.url);
    clients.push(client);
    const keyPrefix = uniquePrefix();
    const p = createRedisStoragePort({ client, keyPrefix });
    port = p;
    return { client, keyPrefix, p };
  }

  async function freshPort(): Promise<RedisStoragePort> {
    started ??= await startRedis();
    port = createRedisStoragePort({ url: started.url, keyPrefix: uniquePrefix() });
    return port;
  }

  afterEach(async () => {
    await port?.close();
    port = undefined;
    for (const client of clients.splice(0)) client.disconnect();
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

  it("reads a selective filter off its field index instead of scanning the whole by-seq log", async () => {
    const { client, keyPrefix, p } = await spiedPort();
    const total = LINEAGE_SCAN_CHUNK_SIZE * 2 + 50;
    const wanted = new Set([7, 600, total - 1]);
    for (let i = 0; i < total; i++) {
      await p.appendLineage(ev(i, { payload: wanted.has(i) ? { correlationId: "c1" } : {} }));
    }
    const zrangebyscore = vi.spyOn(client, "zrangebyscore");
    const hmget = vi.spyOn(client, "hmget");

    const page = await p.pageLineage!({ correlationId: "c1" });

    expect(page.events.map((e) => e.id)).toEqual([...wanted].map((i) => ev(i).id));
    expect(page.nextCursor).toBeUndefined();
    const keys = redisKeys(keyPrefix);
    const scanned = zrangebyscore.mock.calls.map((call) => call[0]);
    expect(scanned).toEqual([keys.lineage.index("correlationId", "c1")]);
    // Only the three indexed ids were hydrated: not one of the unrelated events.
    expect(hmget.mock.calls.flatMap((call) => call.slice(1))).toHaveLength(wanted.size);
  }, 30_000);

  it("uses the by-seq log when the filter has no single-value index (multi-value type)", async () => {
    const { client, keyPrefix, p } = await spiedPort();
    await p.appendLineage(ev(1, { type: "a" }));
    await p.appendLineage(ev(2, { type: "b" }));
    await p.appendLineage(ev(3, { type: "c" }));
    const zrangebyscore = vi.spyOn(client, "zrangebyscore");

    const page = await p.pageLineage!({ type: ["a", "c"] });

    expect(page.events.map((e) => e.id)).toEqual([ev(1).id, ev(3).id]);
    expect(zrangebyscore.mock.calls.map((call) => call[0])).toEqual([redisKeys(keyPrefix).lineage.bySeq]);
  });

  it("stops after the per-call chunk budget with a short page and a cursor that resumes the scan", async () => {
    const { client, keyPrefix, p } = await spiedPort();
    const total = LINEAGE_SCAN_CHUNK_SIZE * 2 + 20;
    for (let i = 0; i < total; i++) {
      // Every event is tenant-scoped (so the filter has an index), only the last one matches the rest.
      await p.appendLineage(ev(i, { tenant: "t", payload: i === total - 1 ? { artifactId: "a1" } : {} }));
    }
    const keys = redisKeys(keyPrefix);
    const req = { tenant: "t", artifactId: "a1" };

    // artifactId is the more selective candidate, so a budget of one chunk is enough there ...
    const viaIndex = await readLineagePage(client, keys, req, 1);
    expect(viaIndex.events.map((e) => e.id)).toEqual([ev(total - 1).id]);

    // ... while a filter that can only scan the tenant index runs out of budget, pages short, and resumes.
    const collected: string[] = [];
    let pages = 0;
    let cursor: string | undefined;
    let sawEmptyPageWithCursor = false;
    for (;;) {
      const page = await readLineagePage(client, keys, { tenant: "t", since: ev(total - 1).ts, cursor }, 1);
      pages++;
      collected.push(...page.events.map((e) => e.id));
      if (page.nextCursor == null) break;
      if (page.events.length === 0) sawEmptyPageWithCursor = true;
      cursor = page.nextCursor;
    }
    expect(collected).toEqual([ev(total - 1).id]);
    expect(pages).toBe(3);
    expect(sawEmptyPageWithCursor).toBe(true);
  }, 30_000);

  it("throws for a malformed cursor", async () => {
    const p = await freshPort();
    await expect(p.pageLineage!({ cursor: "not-a-real-cursor" })).rejects.toThrow();
  });
});
