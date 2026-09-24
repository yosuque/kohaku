import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HmacAuthzPort } from "@kohaku-ui/authz-hmac";
import { dockerAvailable, resolveAdapterBackend } from "@kohaku-ui/port-contracts";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
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
  const SECRET = "test-secret-at-least-32-bytes-long-000";
  const CAP_SECRET = "a-real-capability-secret-for-this-test";

  it("jwt requires a secret or a JWKS URL and exposes the identity resolver", () => {
    expect(() => createAuthzFromEnv({ KOHAKU_AUTHZ: "jwt", KOHAKU_CAPABILITY_SECRET: CAP_SECRET })).toThrow(
      /KOHAKU_JWT_SECRET|KOHAKU_JWT_JWKS_URL/,
    );
    const a = createAuthzFromEnv({
      KOHAKU_AUTHZ: "jwt",
      KOHAKU_JWT_SECRET: SECRET,
      KOHAKU_CAPABILITY_SECRET: CAP_SECRET,
    });
    expect(a.kind).toBe("jwt");
    expect(a.identity).toBeDefined();
  });
  it("defaults to an in-memory revocation store (memory/file storage), with a no-op ready/close", async () => {
    const a = createAuthzFromEnv({});
    await expect(a.ready()).resolves.toBeUndefined();
    await expect(a.close()).resolves.toBeUndefined();
  });

  it("jwt with a jwks URL requires KOHAKU_JWT_AUDIENCE, with a named env error ahead of authz-jwt's own construction error", () => {
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_AUTHZ: "jwt",
        KOHAKU_JWT_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
        KOHAKU_CAPABILITY_SECRET: CAP_SECRET,
      }),
    ).toThrow(/KOHAKU_JWT_AUDIENCE/);
    // A secret-mode config with no audience is unaffected (audience is optional in that mode).
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_AUTHZ: "jwt",
        KOHAKU_JWT_SECRET: SECRET,
        KOHAKU_CAPABILITY_SECRET: CAP_SECRET,
      }),
    ).not.toThrow();
  });

  it("KOHAKU_JWT_REQUIRE_TENANT defaults to required (1) and can be opted out with 0", async () => {
    const { SignJWT } = await import("jose");
    const jwt = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(SECRET));

    const required = createAuthzFromEnv({
      KOHAKU_AUTHZ: "jwt",
      KOHAKU_JWT_SECRET: SECRET,
      KOHAKU_CAPABILITY_SECRET: CAP_SECRET,
    });
    await expect(
      required.identity!.fromAuthorizationHeader(`Bearer ${await jwt({ sub: "u" })}`),
    ).rejects.toMatchObject({ code: "MISSING_TENANT" });

    const optedOut = createAuthzFromEnv({
      KOHAKU_AUTHZ: "jwt",
      KOHAKU_JWT_SECRET: SECRET,
      KOHAKU_JWT_REQUIRE_TENANT: "0",
      KOHAKU_CAPABILITY_SECRET: CAP_SECRET,
    });
    await expect(
      optedOut.identity!.fromAuthorizationHeader(`Bearer ${await jwt({ sub: "u" })}`),
    ).resolves.toMatchObject({ principal: { id: "u" } });
  });

  it("refuses the fixed dev secret once storage leaves file/memory, or once authz is jwt (#11)", () => {
    // hmac + file/memory: the fixed fallback is fine (the demo default this package documents).
    expect(() => createAuthzFromEnv({})).not.toThrow();
    expect(() => createAuthzFromEnv({ KOHAKU_STORAGE: "memory" })).not.toThrow();

    // hmac + redis/postgres: a shared backend with a publicly-known signing secret is a real forgery
    // risk, not a quickstart nicety.
    expect(() =>
      createAuthzFromEnv({ KOHAKU_STORAGE: "redis", KOHAKU_REDIS_URL: "redis://127.0.0.1:1" }),
    ).toThrow(/KOHAKU_CAPABILITY_SECRET must be set to a real secret/);
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_STORAGE: "postgres",
        KOHAKU_POSTGRES_URL: "postgres://u:p@127.0.0.1:1/db",
      }),
    ).toThrow(/KOHAKU_CAPABILITY_SECRET must be set to a real secret/);

    // jwt, regardless of storage: same reasoning -- a verified identity scheme should not still hand out
    // capabilities signed with the well-known default.
    expect(() => createAuthzFromEnv({ KOHAKU_AUTHZ: "jwt", KOHAKU_JWT_SECRET: SECRET })).toThrow(
      /KOHAKU_CAPABILITY_SECRET must be set to a real secret/,
    );
    // An explicit KOHAKU_CAPABILITY_SECRET equal to the fixed default is refused exactly like leaving it
    // unset -- both resolve to the same value the check is guarding against.
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_STORAGE: "redis",
        KOHAKU_REDIS_URL: "redis://127.0.0.1:1",
        KOHAKU_CAPABILITY_SECRET: "dev-secret-change-me",
      }),
    ).toThrow(/KOHAKU_CAPABILITY_SECRET must be set to a real secret/);
    // An empty string, or a whitespace-only value, must not slip through as if it were "a real secret"
    // set to something other than the literal default -- both are treated as unset (fall back to the
    // fixed default, which the guard above then refuses).
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_STORAGE: "redis",
        KOHAKU_REDIS_URL: "redis://127.0.0.1:1",
        KOHAKU_CAPABILITY_SECRET: "",
      }),
    ).toThrow(/KOHAKU_CAPABILITY_SECRET must be set to a real secret/);
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_STORAGE: "redis",
        KOHAKU_REDIS_URL: "redis://127.0.0.1:1",
        KOHAKU_CAPABILITY_SECRET: "   ",
      }),
    ).toThrow(/KOHAKU_CAPABILITY_SECRET must be set to a real secret/);

    // Supplying a real secret clears it in every one of those cases.
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_STORAGE: "redis",
        KOHAKU_REDIS_URL: "redis://127.0.0.1:1",
        KOHAKU_CAPABILITY_SECRET: CAP_SECRET,
      }),
    ).not.toThrow();
    expect(() =>
      createAuthzFromEnv({
        KOHAKU_AUTHZ: "jwt",
        KOHAKU_JWT_SECRET: SECRET,
        KOHAKU_CAPABILITY_SECRET: CAP_SECRET,
      }),
    ).not.toThrow();
  });
});

// The revocation store follows KOHAKU_STORAGE, not KOHAKU_AUTHZ (see createAuthzFromEnv's doc comment):
// with a real redis/postgres backend, revokeCapability on the resulting port must actually revoke,
// proving the store is wired in, not merely type-compatible. Skipped without a backend (see backend.ts's
// sibling resolveAdapterBackend usage in storage-backends.e2e.test.ts).
const principal = { id: "u", roles: ["user"] };
const scope = { kind: "read" as const, ref: "query://s/x" };

const redis = resolveAdapterBackend("redis", process.env, dockerAvailable);
describe.skipIf(redis.mode === "skip")(
  "createAuthzFromEnv: KOHAKU_STORAGE=redis wires a shared revocation store",
  () => {
    it("revokeCapability against a redis-backed store actually revokes verify", async () => {
      const container =
        redis.mode === "container" ? await new RedisContainer("redis:7-alpine").start() : null;
      const url = container?.getConnectionUrl() ?? (redis as { url: string }).url;
      const a = createAuthzFromEnv({
        KOHAKU_STORAGE: "redis",
        KOHAKU_REDIS_URL: url,
        KOHAKU_CAPABILITY_SECRET: "a-real-shared-secret-for-this-test",
      });
      try {
        await a.ready();
        const authz = a.authz as HmacAuthzPort;
        const cap = await authz.issueCapability(principal, [scope]);
        expect((await authz.verify(cap, scope)).ok).toBe(true);
        expect(await authz.revokeCapability(cap)).toEqual({ ok: true });
        expect(await authz.verify(cap, scope)).toEqual({ ok: false, reason: "capability revoked" });
      } finally {
        await a.close();
        await container?.stop();
      }
    }, 120_000);
  },
);

const postgres = resolveAdapterBackend("postgres", process.env, dockerAvailable);
describe.skipIf(postgres.mode === "skip")(
  "createAuthzFromEnv: KOHAKU_STORAGE=postgres wires a shared revocation store",
  () => {
    it("revokeCapability against a postgres-backed store actually revokes verify", async () => {
      const container =
        postgres.mode === "container" ? await new PostgreSqlContainer("postgres:16-alpine").start() : null;
      const connectionString = container?.getConnectionUri() ?? (postgres as { url: string }).url;
      const a = createAuthzFromEnv({
        KOHAKU_STORAGE: "postgres",
        KOHAKU_POSTGRES_URL: connectionString,
        KOHAKU_CAPABILITY_SECRET: "a-real-shared-secret-for-this-test",
      });
      try {
        await a.ready();
        const authz = a.authz as HmacAuthzPort;
        const cap = await authz.issueCapability(principal, [scope]);
        expect((await authz.verify(cap, scope)).ok).toBe(true);
        expect(await authz.revokeCapability(cap)).toEqual({ ok: true });
        expect(await authz.verify(cap, scope)).toEqual({ ok: false, reason: "capability revoked" });
      } finally {
        await a.close();
        await container?.stop();
      }
    }, 120_000);
  },
);
