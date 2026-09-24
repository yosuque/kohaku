import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { LINEAGE_SCAN_CHUNK_SIZE } from "../src/lineage.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

function ev(type: string, seq: number): LineageEventRecord {
  return {
    id: `${type}-${String(seq).padStart(4, "0")}`,
    ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(),
    actor: { kind: "system" },
    type,
    payload: {},
  };
}

interface RecordedRange {
  key: string;
  start: number;
  stop: number;
}

/**
 * Wraps a real (already-connected) ioredis client so every `ZREVRANGE` it issues -- whether called
 * directly or queued on a `pipeline()` -- is recorded before being forwarded to the real client. Used to
 * assert the review fix for the multi-value `type` union path (`readUnionPushdown` / `readUnionScan` in
 * `lineage.ts`): it must never read a whole index (`0 -1`), only bounded windows.
 */
function recordZrevrangeCalls(client: Redis): RecordedRange[] {
  const calls: RecordedRange[] = [];
  const record = (key: string, start: number | string, stop: number | string): void => {
    calls.push({ key, start: Number(start), stop: Number(stop) });
  };

  const originalZrevrange = client.zrevrange.bind(client);
  client.zrevrange = ((key: string, start: number | string, stop: number | string, ...rest: unknown[]) => {
    record(key, start, stop);
    return (originalZrevrange as (...args: unknown[]) => unknown)(key, start, stop, ...rest);
  }) as unknown as Redis["zrevrange"];

  const originalPipeline = client.pipeline.bind(client);
  client.pipeline = ((...pipelineArgs: unknown[]) => {
    const pipeline = (originalPipeline as (...args: unknown[]) => ReturnType<Redis["pipeline"]>)(
      ...pipelineArgs,
    );
    const originalPipelineZrevrange = pipeline.zrevrange.bind(pipeline);
    pipeline.zrevrange = ((
      key: string,
      start: number | string,
      stop: number | string,
      ...rest: unknown[]
    ) => {
      record(key, start, stop);
      return (originalPipelineZrevrange as (...args: unknown[]) => unknown)(key, start, stop, ...rest);
    }) as unknown as ReturnType<Redis["pipeline"]>["zrevrange"];
    return pipeline;
  }) as unknown as Redis["pipeline"];

  return calls;
}

describe.skipIf(backend.mode === "skip")("createRedisStoragePort: multi-value type union read bounds", () => {
  let stop: () => Promise<void>;
  let port: RedisStoragePort;
  let client: Redis;
  let calls: RecordedRange[];

  beforeAll(async () => {
    const started = await startRedis();
    stop = started.stop;
    client = new Redis(started.url);
    calls = recordZrevrangeCalls(client);
    port = createRedisStoragePort({ client, keyPrefix: uniquePrefix() });
  }, 60_000);

  afterAll(async () => {
    await port.close();
    client.disconnect();
    await stop();
  });

  it("an exhaustive multi-type filter reads at most `limit` entries per type, never a whole index", async () => {
    // All of type "a" appended before all of type "b", so "b" holds the newest append-seq scores end to
    // end -- makes the expected merge result unambiguous (the newest `limit` overall are exactly the
    // newest `limit` "b" events) without needing to replicate the merge-by-score arithmetic here.
    const perType = 30;
    for (let i = 0; i < perType; i++) await port.appendLineage(ev("a", i));
    for (let i = 0; i < perType; i++) await port.appendLineage(ev("b", 1000 + i));
    const limit = 10;
    calls.length = 0;

    const result = await port.listLineage({ type: ["a", "b"], limit });

    const typeIndexCalls = calls.filter((c) => c.key.includes(":idx:type:"));
    expect(typeIndexCalls.length).toBeGreaterThan(0);
    for (const call of typeIndexCalls) {
      expect(call.stop).not.toBe(-1); // never the unbounded "read the whole index" form
      expect(call.stop - call.start + 1).toBeLessThanOrEqual(limit);
    }
    // Correctness: all of "a" was appended before any of "b", so the newest `limit` events overall are
    // exactly the newest `limit` "b" events, in append order.
    expect(result).toHaveLength(limit);
    expect(result.every((e) => e.type === "b")).toBe(true);
    expect(result.map((e) => e.id)).toEqual(
      Array.from({ length: limit }, (_, i) => ev("b", 1000 + perType - limit + i).id),
    );
  });

  it("a non-exhaustive multi-type filter (type + since) never issues an unbounded ZREVRANGE either", async () => {
    calls.length = 0;
    const since = ev("b", 1000 + 25).ts;
    const result = await port.listLineage({ type: ["a", "b"], since });

    const typeIndexCalls = calls.filter((c) => c.key.includes(":idx:type:"));
    expect(typeIndexCalls.length).toBeGreaterThan(0);
    for (const call of typeIndexCalls) {
      expect(call.stop).not.toBe(-1);
      expect(call.stop - call.start + 1).toBeLessThanOrEqual(LINEAGE_SCAN_CHUNK_SIZE);
    }
    // Only "b" events (seq 1000+) ever reach `since`; the 5 newest of them (1025..1029).
    expect(result.map((e) => e.id)).toEqual([25, 26, 27, 28, 29].map((i) => ev("b", 1000 + i).id));
  });
});
