import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createRedisRevocationStore } from "../src/index.js";
import { backend, startRedis, uniquePrefix } from "./backend.js";

// Behavior specific to the Redis adapter, beyond the shared CapabilityRevocationStore contract
// (revocation-contract.test.ts): the key's own TTL, and the already-expired no-op. Needs a real
// backend (to inspect EXISTS/TTL directly), so it's gated the same way.
let started: Awaited<ReturnType<typeof startRedis>> | undefined;

async function sharedBackend() {
  if (started == null) started = await startRedis();
  return started;
}

describe.skipIf(backend.mode === "skip")("createRedisRevocationStore", () => {
  afterAll(async () => {
    await started?.stop();
    started = undefined;
  });

  let client: Redis | undefined;
  afterEach(async () => {
    await client?.quit();
    client = undefined;
  });

  it("revoke() sets a key with an EX derived from exp - now, and isRevoked() is an existence check", async () => {
    const { url } = await sharedBackend();
    const prefix = uniquePrefix();
    const store = createRedisRevocationStore({ url, keyPrefix: prefix });
    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiresAt = nowSeconds + 3600;
      await store.revoke("some-jti", expiresAt);

      expect(await store.isRevoked("some-jti")).toBe(true);
      expect(await store.isRevoked("never-registered-jti")).toBe(false);

      client = new Redis(url);
      const ttl = await client.ttl(`${prefix}:revoked:some-jti`);
      // Allow slack for wall-clock drift between the two `now()` reads above and inside revoke().
      expect(ttl).toBeGreaterThan(3500);
      expect(ttl).toBeLessThanOrEqual(3600);
    } finally {
      await store.close();
    }
  });

  it("revoke() is a no-op when exp is already at or before now (the token can't verify anyway)", async () => {
    const { url } = await sharedBackend();
    const prefix = uniquePrefix();
    const store = createRedisRevocationStore({ url, keyPrefix: prefix });
    try {
      const alreadyExpired = Math.floor(Date.now() / 1000) - 10;
      await store.revoke("expired-jti", alreadyExpired);

      expect(await store.isRevoked("expired-jti")).toBe(false);

      client = new Redis(url);
      expect(await client.exists(`${prefix}:revoked:expired-jti`)).toBe(0);
    } finally {
      await store.close();
    }
  });
});
