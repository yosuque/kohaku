import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import {
  createJwtAuthzPort,
  JwtIdentityError,
  type JwtIdentityResolver,
  type ResolvedIdentity,
} from "@kohaku-ui/authz-jwt";
import { errorBody, type KohakuHostDeps } from "@kohaku-ui/host-rest";
import type { AuthzPort, StoragePort } from "@kohaku-ui/spec-core";
import { createFileStoragePort, createMemoryStoragePort } from "@kohaku-ui/storage-memory";
import { createPostgresStoragePort } from "@kohaku-ui/storage-postgres";
import { createRedisStoragePort } from "@kohaku-ui/storage-redis";
import type { Context, MiddlewareHandler } from "hono";

/**
 * Environment-driven selection of the sample's StoragePort / AuthzPort implementations
 * (docs/specification.md §9). Everything here is sample wiring: a product picks its adapters in code.
 */
export type StorageKind = "file" | "memory" | "redis" | "postgres";

export interface StorageFromEnv {
  kind: StorageKind;
  storage: StoragePort;
  close(): Promise<void>;
}

const STORAGE_KINDS: readonly StorageKind[] = ["file", "memory", "redis", "postgres"];

function required(env: NodeJS.ProcessEnv, name: string, forKind: string): string {
  const value = env[name];
  if (value == null || value === "") throw new Error(`${name} is required when KOHAKU_STORAGE=${forKind}`);
  return value;
}

export function createStorageFromEnv(env: NodeJS.ProcessEnv, defaults: { dataDir: string }): StorageFromEnv {
  const kind = (env["KOHAKU_STORAGE"] ?? "file") as StorageKind;
  if (!STORAGE_KINDS.includes(kind)) {
    throw new Error(`KOHAKU_STORAGE must be one of ${STORAGE_KINDS.join(" / ")}, got "${kind}"`);
  }
  switch (kind) {
    case "file":
      return { kind, storage: createFileStoragePort(defaults.dataDir), close: async () => {} };
    case "memory":
      return { kind, storage: createMemoryStoragePort(), close: async () => {} };
    case "redis": {
      const port = createRedisStoragePort({
        url: required(env, "KOHAKU_REDIS_URL", kind),
        ...(env["KOHAKU_STORAGE_KEY_PREFIX"] ? { keyPrefix: env["KOHAKU_STORAGE_KEY_PREFIX"] } : {}),
      });
      return { kind, storage: port, close: () => port.close() };
    }
    case "postgres": {
      const port = createPostgresStoragePort({
        connectionString: required(env, "KOHAKU_POSTGRES_URL", kind),
        ...(env["KOHAKU_POSTGRES_SCHEMA"] ? { schema: env["KOHAKU_POSTGRES_SCHEMA"] } : {}),
      });
      return { kind, storage: port, close: () => port.close() };
    }
  }
}

export type AuthzKind = "hmac" | "jwt";

export interface AuthzFromEnv {
  kind: AuthzKind;
  authz: AuthzPort;
  /** Present only for `jwt`: the resolver the request-identity hooks use. */
  identity?: JwtIdentityResolver;
}

export function createAuthzFromEnv(env: NodeJS.ProcessEnv): AuthzFromEnv {
  const capabilitySecret = env["KOHAKU_CAPABILITY_SECRET"] ?? "dev-secret-change-me";
  const kind = (env["KOHAKU_AUTHZ"] ?? "hmac") as AuthzKind;
  if (kind === "hmac") return { kind, authz: createHmacAuthzPort(capabilitySecret) };
  if (kind !== "jwt") throw new Error(`KOHAKU_AUTHZ must be hmac or jwt, got "${kind}"`);
  const secret = env["KOHAKU_JWT_SECRET"];
  const jwksUrl = env["KOHAKU_JWT_JWKS_URL"];
  if ((secret == null || secret === "") && (jwksUrl == null || jwksUrl === "")) {
    throw new Error("KOHAKU_AUTHZ=jwt requires KOHAKU_JWT_SECRET or KOHAKU_JWT_JWKS_URL");
  }
  const port = createJwtAuthzPort({
    key: secret != null && secret !== "" ? { secret } : { jwksUrl: jwksUrl! },
    ...(env["KOHAKU_JWT_ISSUER"] ? { issuer: env["KOHAKU_JWT_ISSUER"] } : {}),
    ...(env["KOHAKU_JWT_AUDIENCE"] ? { audience: env["KOHAKU_JWT_AUDIENCE"] } : {}),
    capabilitySecret,
  });
  return { kind, authz: port, identity: port.identity };
}

/** How the REST host turns a request into a principal and a tenant. */
export interface RequestIdentity {
  /** Registered on `/api/kohaku/*` ahead of the routes when present (JWT verification + 401). */
  middleware?: MiddlewareHandler;
  auth: NonNullable<KohakuHostDeps["auth"]>;
  tenant: NonNullable<KohakuHostDeps["tenant"]>;
}

/** The demo's header scheme (unchanged): x-kohaku-role (no header = admin) and x-kohaku-tenant. */
export function createHeaderIdentity(): RequestIdentity {
  return {
    // Principal resolution (product responsibility): in real operation, resolve the principal and roles from an auth
    // platform (JWT/OIDC, etc.). The demo substitutes the x-kohaku-role header and treats **no header (default) as admin**
    // (so as not to break the unauthorized behavior of the existing demo and tests; it reproduces, via the admin role,
    // the legacy behavior where the governance plane lets anyone through).
    auth: async (c) => {
      const role = c.req.header("x-kohaku-role") || "admin";
      return { id: `demo-${role}`, roles: [role] };
    },
    // Tenant resolution: the demo looks at the x-kohaku-tenant header. The governance plane (lineage / promotion /
    // fixation) is separated per tenant. query:// is tenant-neutral and does not mix tenant into the cache key (an invariant).
    // Full-fledged tenant isolation (RLS, etc.) is a product responsibility (specification.md §4.4 / §7).
    tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
  };
}

const IDENTITY_VAR = "kohakuIdentity";

/**
 * JWT scheme: the middleware verifies the bearer token once per request and stores the identity on the
 * context; the hooks read it back. A missing or invalid token is a 401 with the standard error envelope
 * (CAPABILITY_DENIED — the SPEC §6.1 code set has no separate "unauthenticated" code, and the envelope is
 * what clients already parse). Principal / roles / tenant then all come from the token, never from headers.
 */
export function createJwtRequestIdentity(identity: JwtIdentityResolver): RequestIdentity {
  const read = (c: Context): ResolvedIdentity | undefined =>
    c.get(IDENTITY_VAR) as ResolvedIdentity | undefined;
  return {
    middleware: async (c, next) => {
      try {
        c.set(IDENTITY_VAR, await identity.fromAuthorizationHeader(c.req.header("authorization")));
      } catch (e) {
        const reason = e instanceof JwtIdentityError ? e.code : "INVALID_TOKEN";
        return c.json(errorBody("CAPABILITY_DENIED", `authentication required (${reason})`), 401);
      }
      await next();
    },
    auth: async (c) => read(c)?.principal ?? null,
    tenant: (c) => read(c)?.tenant,
  };
}
