import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HmacAuthzPort } from "@kohaku-ui/authz-hmac";
import * as storagePostgres from "@kohaku-ui/storage-postgres";
import * as storageRedis from "@kohaku-ui/storage-redis";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createPortsFromEnv } from "../src/ports/from-env.js";

/**
 * `createPortsFromEnv`'s whole point is to open exactly ONE redis client / pg Pool and share it between the
 * StoragePort and the revocation store (finding #4.3: `createStorageFromEnv` + `createAuthzFromEnv` called
 * separately each open their own). Neither the real `ioredis` client nor the real `pg.Pool` connects at
 * construction time (`lazyConnect: true` / pg's own "connects on first query" -- already relied on by
 * `createStorageFromEnv`'s own "redis / postgres require their URL" test above), so this exercises the real
 * adapters with no real network I/O.
 *
 * Note on what is spied on: `createRedisStoragePort` / `createRedisRevocationStore` (and their postgres
 * counterparts) import `createRedisConnection` / `createPostgresPool` directly from their own package's
 * internal `./connection.js`, not through the package's public re-export -- so spying on the public
 * `@kohaku-ui/storage-redis` / `@kohaku-ui/storage-postgres` binding only observes from-env.ts's OWN call
 * (the shared, owned connection), not each adapter's internal one. That is exactly the boundary this file
 * needs: it proves from-env.ts builds the connection exactly once and threads the same `client`/`pool`
 * object into both adapters' `options`, which is what `createRedisStoragePort` / `createPostgresStoragePort`
 * are spied on for below.
 */
const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
afterEach(() => {
  vi.restoreAllMocks();
});
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-ports-from-env-"));
  tmpDirs.push(dir);
  return dir;
}

describe("createPortsFromEnv: redis", () => {
  it("opens exactly one Redis client, and threads it into both the storage port and the revocation store", async () => {
    const connectionSpy = vi.spyOn(storageRedis, "createRedisConnection");
    const storageSpy = vi.spyOn(storageRedis, "createRedisStoragePort");
    const revocationSpy = vi.spyOn(storageRedis, "createRedisRevocationStore");
    const ports = createPortsFromEnv(
      { KOHAKU_STORAGE: "redis", KOHAKU_REDIS_URL: "redis://127.0.0.1:1" },
      { dataDir: dataDir() },
    );
    // from-env.ts itself builds the connection exactly once (owned:true)...
    expect(connectionSpy).toHaveBeenCalledTimes(1);
    expect(connectionSpy.mock.results[0]!.value.owned).toBe(true);
    const sharedClient = connectionSpy.mock.results[0]!.value.redis;
    // ...and passes that exact client into BOTH adapters, rather than each opening its own.
    expect(storageSpy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ client: sharedClient }));
    expect(revocationSpy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ client: sharedClient }));
    expect(ports.kinds).toEqual({ storage: "redis", authz: "hmac" });
    // A shared connection's own close() ends the one owned instance above (never-connected -- quit()
    // rejects immediately under enableOfflineQueue:false and disconnect() is the safe fallback).
    await expect(ports.close()).resolves.toBeUndefined();
  });

  it("kind=redis + KOHAKU_AUTHZ=jwt still shares one client (authz choice does not change the connection count)", async () => {
    const connectionSpy = vi.spyOn(storageRedis, "createRedisConnection");
    const ports = createPortsFromEnv(
      {
        KOHAKU_STORAGE: "redis",
        KOHAKU_REDIS_URL: "redis://127.0.0.1:1",
        KOHAKU_AUTHZ: "jwt",
        KOHAKU_JWT_SECRET: "test-secret-at-least-32-bytes-long-000",
      },
      { dataDir: dataDir() },
    );
    expect(connectionSpy).toHaveBeenCalledTimes(1);
    expect(ports.identity).toBeDefined();
    await expect(ports.close()).resolves.toBeUndefined();
  });
});

describe("createPortsFromEnv: postgres", () => {
  it("opens exactly one pg Pool, and threads it into both the storage port and the revocation store", async () => {
    const poolSpy = vi.spyOn(storagePostgres, "createPostgresPool");
    const storageSpy = vi.spyOn(storagePostgres, "createPostgresStoragePort");
    const revocationSpy = vi.spyOn(storagePostgres, "createPostgresRevocationStore");
    const ports = createPortsFromEnv(
      { KOHAKU_STORAGE: "postgres", KOHAKU_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" },
      { dataDir: dataDir() },
    );
    expect(poolSpy).toHaveBeenCalledTimes(1);
    expect(poolSpy.mock.results[0]!.value.owned).toBe(true);
    const sharedPool = poolSpy.mock.results[0]!.value.pool;
    // Both adapters get the shared pool AND migrate:false, so from-env.ts's own createPostgresPool call
    // (which does NOT set migrate:false) is the only one that actually runs the migration transaction.
    expect(storageSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pool: sharedPool, migrate: false }),
    );
    expect(revocationSpy).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pool: sharedPool, migrate: false }),
    );
    expect(ports.kinds).toEqual({ storage: "postgres", authz: "hmac" });
    await expect(ports.close()).resolves.toBeUndefined();
  });
});

describe("createPortsFromEnv: env validation", () => {
  it("rejects an unknown KOHAKU_STORAGE before opening any connection", () => {
    const redisSpy = vi.spyOn(storageRedis, "createRedisConnection");
    const pgSpy = vi.spyOn(storagePostgres, "createPostgresPool");
    expect(() => createPortsFromEnv({ KOHAKU_STORAGE: "dynamo" }, { dataDir: dataDir() })).toThrow(
      /KOHAKU_STORAGE/,
    );
    expect(redisSpy).not.toHaveBeenCalled();
    expect(pgSpy).not.toHaveBeenCalled();
  });

  it("jwt with a jwks URL and no audience is rejected with a named env error (shared with createAuthzFromEnv)", () => {
    expect(() =>
      createPortsFromEnv(
        {
          KOHAKU_STORAGE: "memory",
          KOHAKU_AUTHZ: "jwt",
          KOHAKU_JWT_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
        },
        { dataDir: dataDir() },
      ),
    ).toThrow(/KOHAKU_JWT_AUDIENCE/);
  });
});

describe("createPortsFromEnv: file / memory", () => {
  it("file: no redis/pg connection is opened; ready()/close() are no-ops", async () => {
    const redisSpy = vi.spyOn(storageRedis, "createRedisConnection");
    const pgSpy = vi.spyOn(storagePostgres, "createPostgresPool");
    const ports = createPortsFromEnv({}, { dataDir: dataDir() });
    expect(ports.kinds).toEqual({ storage: "file", authz: "hmac" });
    await expect(ports.ready()).resolves.toBeUndefined();
    await expect(ports.close()).resolves.toBeUndefined();
    expect(redisSpy).not.toHaveBeenCalled();
    expect(pgSpy).not.toHaveBeenCalled();
  });

  it("memory: same, and the revocation store actually revokes (not a stub)", async () => {
    const ports = createPortsFromEnv({ KOHAKU_STORAGE: "memory" }, { dataDir: dataDir() });
    expect(ports.kinds.storage).toBe("memory");
    const authz = ports.authz as HmacAuthzPort;
    const principal = { id: "u", roles: ["user"] };
    const scope = { kind: "read" as const, ref: "query://s/x" };
    const cap = await authz.issueCapability(principal, [scope]);
    expect((await authz.verify(cap, scope)).ok).toBe(true);
    await authz.revokeCapability(cap);
    expect(await authz.verify(cap, scope)).toEqual({ ok: false, reason: "capability revoked" });
  });
});
