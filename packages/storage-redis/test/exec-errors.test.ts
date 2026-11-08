import type { LineageEventRecord, PromotionState } from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { redisKeys } from "../src/keys.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

function state(id: string, revision = "r1"): PromotionState {
  return { artifactId: id, status: "candidate", updatedAt: "2026-01-01T00:00:00.000Z", data: {}, revision };
}

function event(id: string): LineageEventRecord {
  return {
    id,
    ts: "2026-01-01T00:00:00.000Z",
    actor: { kind: "system" },
    type: "view.composed",
    payload: { intentHash: "h1" },
  };
}

/**
 * A MULTI/EXEC whose EXEC itself succeeds but one of its COMMANDS fails at run time (here: a ZADD / ZREM on a
 * key that holds a string, i.e. WRONGTYPE, after an earlier command of the same transaction already applied).
 * ioredis resolves `exec()` with a `[error, result]` pair per command, so a check on the reply being `null`
 * alone reads that as success. Every EXEC site must instead throw, and must not call it a
 * `StorageConflictError` (nothing was rolled back; the store may be inconsistent).
 */
describe.skipIf(backend.mode === "skip")(
  "createRedisStoragePort: per-command errors in an EXEC reply",
  () => {
    let stop: () => Promise<void>;
    let url: string;
    let raw: Redis;
    let port: RedisStoragePort;
    let keys: ReturnType<typeof redisKeys>;

    beforeAll(async () => {
      const started = await startRedis();
      stop = started.stop;
      url = started.url;
      raw = new Redis(url);
    });
    afterAll(async () => {
      raw.disconnect();
      await stop();
    });

    async function open(): Promise<void> {
      const prefix = uniquePrefix();
      keys = redisKeys(prefix);
      port = createRedisStoragePort({ url, keyPrefix: prefix });
      await port.ready();
    }

    /** Expects a rejection that is a partial-application error and not a CAS conflict. */
    async function expectPartialFailure(fn: () => Promise<unknown>): Promise<void> {
      const error = await fn().then(
        () => undefined,
        (e: unknown) => e as Error & { code?: unknown },
      );
      expect(error, "the write must reject").toBeDefined();
      expect(error?.code).not.toBe("STORAGE_CONFLICT");
      expect(error?.message).toMatch(/partially applied/);
      expect(error?.message).toMatch(/WRONGTYPE/);
      expect((error?.cause as Error | undefined)?.message).toMatch(/WRONGTYPE/);
    }

    it("CAS putPromotionState throws (and is not a conflict) when the index ZADD fails after the SET", async () => {
      await open();
      try {
        await raw.set(keys.promotionIndex(undefined), "not-a-zset");
        await expectPartialFailure(() => port.putPromotionState(state("a1"), { expectedRevision: null }));
      } finally {
        await port.close();
      }
    });

    it("CAS deleteFixation throws when the index ZREM fails after the DEL", async () => {
      await open();
      try {
        await port.putFixation({
          intentHash: "h",
          canonical: "c",
          structureHash: "s",
          pinnedSpec: { version: "0.1", root: { type: "text" } } as never,
          fixatedAt: "2026-01-01T00:00:00.000Z",
          approver: { id: "x" },
          revision: "r1",
        });
        await raw.del(keys.fixationIndex(undefined));
        await raw.set(keys.fixationIndex(undefined), "not-a-zset");
        await expectPartialFailure(() => port.deleteFixation!("h", undefined, { expectedRevision: "r1" }));
      } finally {
        await port.close();
      }
    });

    it("plain putPromotionState (putIndexed) throws", async () => {
      await open();
      try {
        await raw.set(keys.promotionIndex(undefined), "not-a-zset");
        await expectPartialFailure(() => port.putPromotionState(state("a2")));
      } finally {
        await port.close();
      }
    });

    it("putPromotionStates (putIndexedMany) throws", async () => {
      await open();
      try {
        await raw.set(keys.promotionIndex(undefined), "not-a-zset");
        await expectPartialFailure(() => port.putPromotionStates!([state("a3"), state("a4")]));
      } finally {
        await port.close();
      }
    });

    it("appendLineage throws when an index ZADD fails after the HSETNX", async () => {
      await open();
      try {
        await raw.set(keys.lineage.bySeq, "not-a-zset");
        await expectPartialFailure(() => port.appendLineage(event("e1")));
      } finally {
        await port.close();
      }
    });

    it("plain deleteFixation throws when the index ZREM fails", async () => {
      await open();
      try {
        await raw.set(keys.fixationIndex(undefined), "not-a-zset");
        await expectPartialFailure(() => port.deleteFixation!("h", undefined));
      } finally {
        await port.close();
      }
    });
  },
);
