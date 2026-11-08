import type { PromotionState } from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

function state(revision: string, status = "candidate"): PromotionState {
  return { artifactId: "a1", status, updatedAt: "2026-01-01T00:00:00.000Z", data: {}, revision };
}

// Two ports on the same backend and key prefix stand in for two host instances: they share no in-process
// mutex, so only WATCH / MULTI / EXEC (not the port's own serialization) can make exactly one of two writes
// from the same base win. The shared contract only races writes through ONE port instance.
describe.skipIf(backend.mode === "skip")("createRedisStoragePort: compare-and-set across instances", () => {
  let stop: () => Promise<void>;
  let url: string;
  let prefix: string;
  let a: RedisStoragePort;
  let b: RedisStoragePort;
  beforeAll(async () => {
    const started = await startRedis();
    stop = started.stop;
    url = started.url;
  });
  afterAll(async () => {
    await stop();
  });

  async function openPair(): Promise<void> {
    prefix = uniquePrefix();
    a = createRedisStoragePort({ url, keyPrefix: prefix });
    b = createRedisStoragePort({ url, keyPrefix: prefix });
  }

  it("lets exactly one of two instances win a write from the same base, every round", async () => {
    await openPair();
    try {
      for (let round = 0; round < 25; round++) {
        const base = `base${round}`;
        await a.putPromotionState(state(base));
        const settled = await Promise.allSettled([
          a.putPromotionState(state(`a${round}`, "approved"), { expectedRevision: base }),
          b.putPromotionState(state(`b${round}`, "rejected"), { expectedRevision: base }),
        ]);
        const winners = settled.filter((r) => r.status === "fulfilled");
        const losers = settled.filter((r) => r.status === "rejected");
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({ code: "STORAGE_CONFLICT" });
        const stored = await a.getPromotionState("a1");
        expect([`a${round}`, `b${round}`]).toContain(stored?.revision);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('lets exactly one of two instances win a write from the same unversioned base ("")', async () => {
    await openPair();
    try {
      for (let round = 0; round < 10; round++) {
        const { revision: _omit, ...legacy } = state("x");
        await a.putPromotionState({ ...legacy, artifactId: `u${round}` }); // predates `revision`
        const settled = await Promise.allSettled([
          a.putPromotionState(
            { ...state(`a${round}`, "approved"), artifactId: `u${round}` },
            { expectedRevision: "" },
          ),
          b.putPromotionState(
            { ...state(`b${round}`, "rejected"), artifactId: `u${round}` },
            { expectedRevision: "" },
          ),
        ]);
        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const loser = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(loser.reason).toMatchObject({ code: "STORAGE_CONFLICT" });
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("does not let a plain (non-CAS) write on the shared connection clear a pending watch", async () => {
    await openPair();
    try {
      await a.putPromotionState(state("r1"));
      // Interleave many plain writes (their own MULTI/EXEC on the shared connection) with a CAS write.
      const noise = Array.from({ length: 20 }, (_, i) =>
        a.putPromotionState({ ...state(`n${i}`), artifactId: `n${i}` }),
      );
      const results = await Promise.allSettled([
        ...noise,
        b.putPromotionState(state("r2", "approved"), { expectedRevision: "r1" }),
        a.putPromotionState(state("r3", "rejected"), { expectedRevision: "r1" }),
      ]);
      const cas = results.slice(-2);
      expect(cas.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("close() is idempotent for url-constructed ports that used compare-and-set", async () => {
    await openPair();
    await a.putPromotionState(state("r1"), { expectedRevision: null });
    await a.close();
    await b.close();
    await a.close();
  });

  it("closes the dedicated compare-and-set connection of an injected-client port, and leaves the injected client connected", async () => {
    // Count only this test's connections: a unique connection name is inherited by `duplicate()`, so the
    // dedicated compare-and-set connection carries it too. The server-wide `connected_clients` figure is
    // shared with every other suite using the same Redis (Python storage + interop run in parallel) and
    // made this test flaky.
    const connectionName = `cas-close-${Math.random().toString(36).slice(2)}`;
    const client = new Redis(url, { connectionName });
    const clientsBefore = async () => {
      const list = String(await client.call("CLIENT", "LIST"));
      return list.split("\n").filter((line) => line.includes(` name=${connectionName} `)).length;
    };
    try {
      const port = createRedisStoragePort({ client, keyPrefix: uniquePrefix() });
      const baseline = await clientsBefore();
      await port.putPromotionState(state("r1"), { expectedRevision: null });
      // The first compare-and-set write opened one extra (duplicated) connection ...
      expect(await clientsBefore()).toBe(baseline + 1);
      await port.close();
      // ... close() ended it, while the injected client is still usable (its owner disconnects it).
      expect(await clientsBefore()).toBe(baseline);
      expect(client.status).toBe("ready");
    } finally {
      client.disconnect();
    }
  });

  it("a reconnect of the dedicated connection between WATCH and EXEC is a conflict, never an unguarded write", async () => {
    const client = new Redis(url);
    try {
      const realDuplicate = client.duplicate.bind(client);
      let duplicateOptions: Record<string, unknown> | undefined;
      client.duplicate = ((override?: Record<string, unknown>) => {
        duplicateOptions = override;
        const dup = realDuplicate(override);
        const realGet = dup.get.bind(dup);
        // Simulate ioredis re-establishing the connection (a new "ready") right after the GET: the server
        // dropped the WATCH with the old connection.
        (dup as unknown as { get: unknown }).get = async (key: string) => {
          const value = await realGet(key);
          dup.emit("ready");
          return value;
        };
        return dup;
      }) as typeof client.duplicate;
      const port = createRedisStoragePort({ client, keyPrefix: uniquePrefix() });
      await expect(port.putPromotionState(state("r1"), { expectedRevision: null })).rejects.toMatchObject({
        code: "STORAGE_CONFLICT",
      });
      expect(await port.getPromotionState("a1")).toBeNull();
      // Commands are neither queued while disconnected nor re-sent after a reconnect.
      expect(duplicateOptions).toMatchObject({
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
      });
      await port.close();
    } finally {
      client.disconnect();
    }
  });
});
