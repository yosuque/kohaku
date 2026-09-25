import { createHmacAuthzPort, createMemoryRevocationStore } from "@kohaku-ui/authz-hmac";
import { createJwtAuthzPort, type JwtIdentityResolver } from "@kohaku-ui/authz-jwt";
import type { AuthzPort, CapabilityRevocationStore, StoragePort } from "@kohaku-ui/spec-core";
import { createFileStoragePort, createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import {
  createPostgresPool,
  createPostgresRevocationStore,
  createPostgresStoragePort,
} from "@kohaku-ui/storage-postgres";
import {
  createRedisConnection,
  createRedisRevocationStore,
  createRedisStoragePort,
} from "@kohaku-ui/storage-redis";

/**
 * Environment-driven selection of the sample's StoragePort / AuthzPort implementations
 * (docs/specification.md §9). Everything here is sample wiring: a product picks its adapters in code.
 *
 * Deliberately framework-free: no hono / host-rest import here (that would force sample-mcp, which imports
 * this module's adapter-selection exports via `@kohaku-ui-sample/api/ports/from-env`, to pull in the REST
 * framework too). The REST-only request → principal/tenant resolution lives in `../app/request-identity.ts`.
 */
export type StorageKind = "file" | "memory" | "redis" | "postgres";

export interface StorageFromEnv {
  kind: StorageKind;
  storage: StoragePort;
  /**
   * Resolves once `storage` is ready to accept calls (a no-op for file/memory). The redis/postgres branches
   * delegate to their concrete port's own `ready()` (not part of the `StoragePort` contract itself --
   * `ports.ts` is deliberately not widened for this) so a caller can fail fast at startup instead of
   * discovering an unreachable backend on the first request.
   */
  ready(): Promise<void>;
  close(): Promise<void>;
}

const STORAGE_KINDS: readonly StorageKind[] = ["file", "memory", "redis", "postgres"];

function required(env: NodeJS.ProcessEnv, name: string, forKind: string): string {
  const value = env[name];
  if (value == null || value === "") throw new Error(`${name} is required when KOHAKU_STORAGE=${forKind}`);
  return value;
}

/** Validates and returns `KOHAKU_STORAGE` (default "file"). The single place this env var is parsed. */
function storageKindFromEnv(env: NodeJS.ProcessEnv): StorageKind {
  const kind = (env["KOHAKU_STORAGE"] ?? "file") as StorageKind;
  if (!STORAGE_KINDS.includes(kind)) {
    throw new Error(`KOHAKU_STORAGE must be one of ${STORAGE_KINDS.join(" / ")}, got "${kind}"`);
  }
  return kind;
}

/** Redis connection options shared by the storage port and the revocation store (same `KOHAKU_STORAGE=redis` env). */
function redisOptionsFromEnv(env: NodeJS.ProcessEnv, forKind: string): { url: string; keyPrefix?: string } {
  return {
    url: required(env, "KOHAKU_REDIS_URL", forKind),
    ...(env["KOHAKU_STORAGE_KEY_PREFIX"] ? { keyPrefix: env["KOHAKU_STORAGE_KEY_PREFIX"] } : {}),
  };
}

/** Postgres connection options shared by the storage port and the revocation store (same `KOHAKU_STORAGE=postgres` env). */
function postgresOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  forKind: string,
): { connectionString: string; schema?: string } {
  return {
    connectionString: required(env, "KOHAKU_POSTGRES_URL", forKind),
    ...(env["KOHAKU_POSTGRES_SCHEMA"] ? { schema: env["KOHAKU_POSTGRES_SCHEMA"] } : {}),
  };
}

export function createStorageFromEnv(env: NodeJS.ProcessEnv, defaults: { dataDir: string }): StorageFromEnv {
  const kind = storageKindFromEnv(env);
  switch (kind) {
    case "file":
      return {
        kind,
        storage: createFileStoragePort(defaults.dataDir),
        ready: async () => {},
        close: async () => {},
      };
    case "memory":
      return { kind, storage: createMemoryStoragePort(), ready: async () => {}, close: async () => {} };
    case "redis": {
      const port = createRedisStoragePort(redisOptionsFromEnv(env, kind));
      return { kind, storage: port, ready: () => port.ready(), close: () => port.close() };
    }
    case "postgres": {
      const port = createPostgresStoragePort(postgresOptionsFromEnv(env, kind));
      return { kind, storage: port, ready: () => port.ready(), close: () => port.close() };
    }
  }
}

export type AuthzKind = "hmac" | "jwt";

export interface AuthzFromEnv {
  kind: AuthzKind;
  authz: AuthzPort;
  /** Present only for `jwt`: the resolver the request-identity hooks use. */
  identity?: JwtIdentityResolver;
  /**
   * Resolves once the revocation store backing `authz` is ready to accept calls (a no-op for the
   * in-memory store; the redis/postgres branches delegate to their concrete store's own `ready()` --
   * same fail-fast reasoning as `StorageFromEnv.ready`).
   */
  ready(): Promise<void>;
  /** Closes the revocation store's backend connection, if any (a no-op for the in-memory store). */
  close(): Promise<void>;
}

interface RevocationsFromEnv {
  revocations: CapabilityRevocationStore;
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The revocation store follows the storage selection (`KOHAKU_STORAGE`), not `KOHAKU_AUTHZ`: a
 * multi-instance deployment needs a shared store regardless of which capability scheme issues the
 * tokens, and it needs to survive a restart the same way the Spec cache does. `memory` and `file` (which
 * has no natural place to persist revocations) both get the in-memory store -- fine for a single
 * instance; a multi-instance deployment should run `KOHAKU_STORAGE=redis|postgres`.
 */
function createRevocationsFromEnv(env: NodeJS.ProcessEnv): RevocationsFromEnv {
  const kind = storageKindFromEnv(env);
  switch (kind) {
    case "redis": {
      const store = createRedisRevocationStore(redisOptionsFromEnv(env, kind));
      return { revocations: store, ready: () => store.ready(), close: () => store.close() };
    }
    case "postgres": {
      const store = createPostgresRevocationStore(postgresOptionsFromEnv(env, kind));
      return { revocations: store, ready: () => store.ready(), close: () => store.close() };
    }
    case "memory":
    case "file":
      return { revocations: createMemoryRevocationStore(), ready: async () => {}, close: async () => {} };
  }
}

/**
 * Builds the AuthzPort itself (hmac / jwt) against an already-built revocation store. Shared by
 * `createAuthzFromEnv` (its own, independently-connected revocation store) and `createPortsFromEnv` (a
 * revocation store sharing one connection with the StoragePort) so the hmac/jwt selection logic -- and the
 * env-validation error messages -- exist exactly once.
 */
function buildAuthzFromEnv(
  env: NodeJS.ProcessEnv,
  revocations: CapabilityRevocationStore,
): { kind: AuthzKind; authz: AuthzPort; identity?: JwtIdentityResolver } {
  // An empty or whitespace-only value is treated exactly like an unset one (falls back to the fixed
  // default) rather than being passed through as a literal near-empty secret -- `.trim()` here only
  // decides *whether* the env value counts as set, the value used below is still the untrimmed original.
  const rawCapabilitySecret = env["KOHAKU_CAPABILITY_SECRET"];
  const capabilitySecret =
    rawCapabilitySecret != null && rawCapabilitySecret.trim() !== ""
      ? rawCapabilitySecret
      : "dev-secret-change-me";
  const kind = (env["KOHAKU_AUTHZ"] ?? "hmac") as AuthzKind;
  // The fixed fallback above is a file/hmac demo convenience only. Once either storage or authz leaves
  // the single-process, header-based demo shape -- a shared redis/postgres backend, or JWT-verified
  // identity -- a capability token signed with a secret every clone of this repo also knows is a real
  // forgery risk, not a quickstart nicety, so refuse to start rather than run production-shaped
  // infrastructure on a publicly known secret.
  const storageKind = storageKindFromEnv(env);
  if (
    capabilitySecret === "dev-secret-change-me" &&
    (storageKind === "redis" || storageKind === "postgres" || kind === "jwt")
  ) {
    throw new Error(
      "KOHAKU_CAPABILITY_SECRET must be set to a real secret when KOHAKU_STORAGE=redis|postgres or KOHAKU_AUTHZ=jwt",
    );
  }
  if (kind === "hmac") {
    return { kind, authz: createHmacAuthzPort(capabilitySecret, { revocations }) };
  }
  if (kind !== "jwt") throw new Error(`KOHAKU_AUTHZ must be hmac or jwt, got "${kind}"`);
  const secret = env["KOHAKU_JWT_SECRET"];
  const jwksUrl = env["KOHAKU_JWT_JWKS_URL"];
  if ((secret == null || secret === "") && (jwksUrl == null || jwksUrl === "")) {
    throw new Error("KOHAKU_AUTHZ=jwt requires KOHAKU_JWT_SECRET or KOHAKU_JWT_JWKS_URL");
  }
  const audience = env["KOHAKU_JWT_AUDIENCE"];
  const usingJwks = secret == null || secret === "";
  if (usingJwks && (audience == null || audience === "")) {
    // Named env-shaped error ahead of @kohaku-ui/authz-jwt's own generic "audience is required when key is
    // jwksUrl or jwks" construction error, so a misconfiguration points at the right env var immediately
    // (same style as the KOHAKU_JWT_SECRET / KOHAKU_JWT_JWKS_URL check above).
    throw new Error("KOHAKU_AUTHZ=jwt with KOHAKU_JWT_JWKS_URL requires KOHAKU_JWT_AUDIENCE");
  }
  // Default true (a token with no tenant claim is rejected) whenever JWT is in play: the promotion /
  // fixation / lineage governance plane is separated per tenant, so silently falling back to "no tenant"
  // is far more likely to be a misconfigured issuer than an intentional single-tenant deployment. Set
  // KOHAKU_JWT_REQUIRE_TENANT=0 to opt out (e.g. a genuinely single-tenant deployment).
  const requireTenant = env["KOHAKU_JWT_REQUIRE_TENANT"] !== "0";
  const port = createJwtAuthzPort({
    key: !usingJwks ? { secret: secret! } : { jwksUrl: jwksUrl! },
    ...(env["KOHAKU_JWT_ISSUER"] ? { issuer: env["KOHAKU_JWT_ISSUER"] } : {}),
    ...(audience ? { audience } : {}),
    requireTenant,
    capabilitySecret,
    revocations,
  });
  return { kind, authz: port, identity: port.identity };
}

export function createAuthzFromEnv(env: NodeJS.ProcessEnv): AuthzFromEnv {
  const revocationsFromEnv = createRevocationsFromEnv(env);
  const { kind, authz, identity } = buildAuthzFromEnv(env, revocationsFromEnv.revocations);
  return {
    kind,
    authz,
    ...(identity != null ? { identity } : {}),
    ready: revocationsFromEnv.ready,
    close: revocationsFromEnv.close,
  };
}

export interface PortsFromEnv {
  storage: StoragePort;
  authz: AuthzPort;
  revocations: CapabilityRevocationStore;
  /** Present only for `KOHAKU_AUTHZ=jwt`: the resolver the request-identity hooks use. */
  identity?: JwtIdentityResolver;
  /** Resolves once the shared connection (redis/postgres) is ready, or immediately for file/memory. */
  ready(): Promise<void>;
  /** Closes the shared connection once (a no-op for file/memory). */
  close(): Promise<void>;
  kinds: { storage: StorageKind; authz: AuthzKind };
}

/**
 * The single entry point a process should use to build every env-selected Port at once (`index.ts` /
 * sample-mcp's `setup.ts`): unlike calling `createStorageFromEnv` + `createAuthzFromEnv` separately (which
 * each open their own redis client / pg Pool -- two connections to the same backend for one process), this
 * opens exactly ONE connection when `KOHAKU_STORAGE` is `redis` or `postgres` and injects it into both the
 * StoragePort and the revocation store backing `authz` (via their `client` / `pool` options), because the
 * revocation store always follows the storage selection regardless of `KOHAKU_AUTHZ` (see
 * `createRevocationsFromEnv`'s doc comment). `ready()` / `close()` then govern that one connection.
 * For `file` / `memory`, there is nothing to share (the revocation store is already in-memory), so this
 * simply delegates to `createStorageFromEnv`.
 */
export function createPortsFromEnv(env: NodeJS.ProcessEnv, defaults: { dataDir: string }): PortsFromEnv {
  const kind = storageKindFromEnv(env);
  if (kind === "file" || kind === "memory") {
    const storageFromEnv = createStorageFromEnv(env, defaults);
    const revocations = createMemoryRevocationStore();
    const { kind: authzKind, authz, identity } = buildAuthzFromEnv(env, revocations);
    return {
      storage: storageFromEnv.storage,
      authz,
      revocations,
      ...(identity != null ? { identity } : {}),
      ready: storageFromEnv.ready,
      close: storageFromEnv.close,
      kinds: { storage: kind, authz: authzKind },
    };
  }
  if (kind === "redis") {
    // Owned (url-constructed): this handle's ready()/close() govern the one underlying client. Injecting
    // `client` into the storage port / revocation store below makes each of them wrap the same client
    // (owned:false for them -- their own ready()/close() become no-ops / instant, see storage-redis's
    // connection.ts), so there is exactly one TCP connection for the whole process.
    const connection = createRedisConnection(redisOptionsFromEnv(env, kind), "sample-api ports");
    const keyPrefix = env["KOHAKU_STORAGE_KEY_PREFIX"];
    const storage = createRedisStoragePort({
      client: connection.redis,
      ...(keyPrefix ? { keyPrefix } : {}),
    });
    const revocations = createRedisRevocationStore({
      client: connection.redis,
      ...(keyPrefix ? { keyPrefix } : {}),
    });
    const { kind: authzKind, authz, identity } = buildAuthzFromEnv(env, revocations);
    return {
      storage,
      authz,
      revocations,
      ...(identity != null ? { identity } : {}),
      ready: connection.ready,
      close: connection.close,
      kinds: { storage: kind, authz: authzKind },
    };
  }
  // postgres: same "one owned pool, inject into both" shape. `migrate: false` on the injected uses --
  // the owned `connection.ready()` below already runs (and memoizes) the real migration once; without
  // this, each of `createPostgresStoragePort` / `createPostgresRevocationStore` would otherwise re-run
  // the (idempotent, but redundant) migration transaction the first time its own `ready()` is awaited.
  const connection = createPostgresPool(postgresOptionsFromEnv(env, kind));
  const schema = env["KOHAKU_POSTGRES_SCHEMA"];
  const storage = createPostgresStoragePort({
    pool: connection.pool,
    migrate: false,
    ...(schema ? { schema } : {}),
  });
  const revocations = createPostgresRevocationStore({
    pool: connection.pool,
    migrate: false,
    ...(schema ? { schema } : {}),
  });
  const { kind: authzKind, authz, identity } = buildAuthzFromEnv(env, revocations);
  return {
    storage,
    authz,
    revocations,
    ...(identity != null ? { identity } : {}),
    ready: connection.ready,
    close: connection.close,
    kinds: { storage: kind, authz: authzKind },
  };
}
