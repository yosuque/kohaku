import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAuthzFromEnv, createStorageFromEnv } from "../src/ports/from-env.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-from-env-"));
  tmpDirs.push(dir);
  return dir;
}

describe("createStorageFromEnv", () => {
  it("defaults to the file port", async () => {
    const s = createStorageFromEnv({}, { dataDir: dataDir() });
    expect(s.kind).toBe("file");
    // file/memory's ready() is a no-op (see StorageFromEnv.ready's doc comment) -- it must still resolve.
    await expect(s.ready()).resolves.toBeUndefined();
    await s.close();
  });
  it("memory", async () => {
    const s = createStorageFromEnv({ KOHAKU_STORAGE: "memory" }, { dataDir: dataDir() });
    expect(s.kind).toBe("memory");
    await expect(s.ready()).resolves.toBeUndefined();
    await s.storage.putSpecCache("k", { key: "k" } as never);
    expect(await s.storage.getSpecCache("k")).toEqual({ key: "k" });
    await s.close();
  });
  it("redis / postgres require their URL (fail-fast) and construct lazily-connecting ports otherwise", async () => {
    expect(() => createStorageFromEnv({ KOHAKU_STORAGE: "redis" }, { dataDir: dataDir() })).toThrow(
      /KOHAKU_REDIS_URL/,
    );
    expect(() => createStorageFromEnv({ KOHAKU_STORAGE: "postgres" }, { dataDir: dataDir() })).toThrow(
      /KOHAKU_POSTGRES_URL/,
    );
    // No connection is attempted at construction time for postgres (pg.Pool connects on first query).
    const pg = createStorageFromEnv(
      { KOHAKU_STORAGE: "postgres", KOHAKU_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db" },
      { dataDir: dataDir() },
    );
    expect(pg.kind).toBe("postgres");
    expect(typeof pg.ready).toBe("function");
    await pg.close();
  });
  it("rejects an unknown kind", () => {
    expect(() => createStorageFromEnv({ KOHAKU_STORAGE: "dynamo" }, { dataDir: dataDir() })).toThrow(
      /KOHAKU_STORAGE/,
    );
  });
});

describe("createAuthzFromEnv", () => {
  it("defaults to hmac with no identity resolver", () => {
    const a = createAuthzFromEnv({});
    expect(a.kind).toBe("hmac");
    expect(a.identity).toBeUndefined();
  });
  it("jwt requires a secret or a JWKS URL and exposes the identity resolver", () => {
    expect(() => createAuthzFromEnv({ KOHAKU_AUTHZ: "jwt" })).toThrow(
      /KOHAKU_JWT_SECRET|KOHAKU_JWT_JWKS_URL/,
    );
    const a = createAuthzFromEnv({
      KOHAKU_AUTHZ: "jwt",
      KOHAKU_JWT_SECRET: "test-secret-at-least-32-bytes-long-000",
    });
    expect(a.kind).toBe("jwt");
    expect(a.identity).toBeDefined();
  });
});
