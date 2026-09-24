import type { UISpec } from "@kohaku-ui/spec-core";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisStoragePort, type RedisStoragePort } from "../src/index.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

function fakeSpec(id: string): UISpec {
  return { key: id } as unknown as UISpec;
}

describe.skipIf(backend.mode === "skip")("createRedisStoragePort: spec cache", () => {
  let stop: () => Promise<void>;
  let url: string;
  let port: RedisStoragePort;
  const prefix = uniquePrefix();

  beforeAll(async () => {
    const started = await startRedis();
    url = started.url;
    stop = started.stop;
    port = createRedisStoragePort({ url, keyPrefix: prefix });
  });
  afterAll(async () => {
    await port.close();
    await stop();
  });

  it("stores and returns a Spec by key, and null for an unknown key", async () => {
    await port.putSpecCache("k1", fakeSpec("k1"));
    expect(await port.getSpecCache("k1")).toEqual(fakeSpec("k1"));
    expect(await port.getSpecCache("nope")).toBeNull();
  });

  it("applies ttlSeconds as a Redis expiry", async () => {
    await port.putSpecCache("ttl", fakeSpec("ttl"), 100);
    const raw = new Redis(url);
    try {
      const ttl = await raw.ttl(`${prefix}:spec:ttl`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(100);
    } finally {
      raw.disconnect();
    }
  });

  it("keeps an entry without ttl indefinitely (TTL -1)", async () => {
    await port.putSpecCache("forever", fakeSpec("forever"));
    const raw = new Redis(url);
    try {
      expect(await raw.ttl(`${prefix}:spec:forever`)).toBe(-1);
    } finally {
      raw.disconnect();
    }
  });

  it("is shared across two port instances on the same Redis (the multi-instance cache)", async () => {
    const other = createRedisStoragePort({ url, keyPrefix: prefix });
    try {
      await port.putSpecCache("shared", fakeSpec("shared"));
      expect(await other.getSpecCache("shared")).toEqual(fakeSpec("shared"));
    } finally {
      await other.close();
    }
  });

  it("close() on an injected client leaves that client connected", async () => {
    const client = new Redis(url);
    const injected = createRedisStoragePort({ client, keyPrefix: prefix });
    await injected.close();
    expect(await client.ping()).toBe("PONG");
    client.disconnect();
  });
});
