import type { Principal } from "@kohaku-ui/spec-core";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import { bearerToken } from "./bearer.js";

export type JwtKeySource = { secret: string } | { jwks: JSONWebKeySet } | { jwksUrl: string | URL };

/** Claim names the default mapping reads. Override for issuers that namespace custom claims (Auth0-style URLs). */
export interface JwtClaimNames {
  subject?: string;
  name?: string;
  roles?: string;
  tenant?: string;
}

export interface ResolvedIdentity {
  principal: Principal;
  tenant?: string;
}

export interface JwtIdentityOptions {
  key: JwtKeySource;
  issuer?: string | string[];
  /**
   * The expected `aud` claim. REQUIRED when `key` is `jwksUrl` or `jwks` (a JWKS-configured resolver
   * typically talks to a third-party issuer that mints tokens for other audiences too, so skipping the
   * `aud` check there would accept a token never meant for this service) -- the constructor throws if
   * omitted in either mode. Optional in `secret` mode (a single shared secret is usually already
   * service-specific, so there is no comparable cross-audience risk).
   */
  audience?: string | string[];
  /** Seconds of leeway on exp / nbf. Default 0. */
  clockToleranceSeconds?: number;
  /** Allowed `alg` values. Default: ["HS256"] for a secret, ["RS256", "ES256", "EdDSA"] for a JWK set. */
  algorithms?: string[];
  claims?: JwtClaimNames;
  /** Full override of the claims → identity mapping (the verified payload is passed in). Bypasses the
   * default mapping entirely, including `requireTenant` below -- a caller supplying `mapClaims` is
   * responsible for its own tenant requirement, if any. */
  mapClaims?: (payload: JWTPayload) => ResolvedIdentity;
  /**
   * When true, a token with no (or an empty) tenant claim resolves to a `JwtIdentityError` with code
   * `MISSING_TENANT`, instead of the default `{ principal }` (no tenant). Default false. Only applies to
   * the default claim mapping (ignored when `mapClaims` is supplied — see its doc comment).
   */
  requireTenant?: boolean;
}

export type JwtIdentityErrorCode = "MISSING_TOKEN" | "INVALID_TOKEN" | "MISSING_SUBJECT" | "MISSING_TENANT";

/** Minimum HS256 shared-secret length (bytes, UTF-8), enforced at construction in `secret` mode. 32 bytes
 * (256 bits) matches HS256's own hash output size -- a shorter secret is brute-forceable well before the
 * hash itself becomes the weak link. */
const MIN_HMAC_SECRET_BYTES = 32;

/** Hostnames `jwksUrl` may use over plain `http:` (never in production; local development / tests only).
 * `URL.hostname` renders an IPv6 literal with brackets (`new URL("http://[::1]/").hostname === "[::1]"`). */
const LOCAL_JWKS_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class JwtIdentityError extends Error {
  readonly code: JwtIdentityErrorCode;
  constructor(code: JwtIdentityErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JwtIdentityError";
    this.code = code;
  }
}

export interface JwtIdentityResolver {
  resolve(token: string): Promise<ResolvedIdentity>;
  fromAuthorizationHeader(header: string | null | undefined): Promise<ResolvedIdentity>;
}

const DEFAULT_CLAIMS: Required<JwtClaimNames> = {
  subject: "sub",
  name: "name",
  roles: "roles",
  tenant: "tenant",
};

/**
 * Rejects an `http:` `jwksUrl` unless it targets a local host (`localhost` / `127.0.0.1` / `::1`) --
 * fetching a JWKS over plain HTTP to a real issuer would let a network attacker substitute their own keys
 * and forge tokens this resolver would then accept. `https:` is always allowed. Thrown at construction, so
 * a misconfiguration is caught before the first token is ever verified.
 */
function assertJwksUrlAllowed(jwksUrl: string | URL): void {
  const url = jwksUrl instanceof URL ? jwksUrl : new URL(jwksUrl);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOCAL_JWKS_HOSTS.has(url.hostname)) return;
  throw new Error(
    `jwksUrl must use https: (http: is only allowed for localhost/127.0.0.1/::1), got "${url.protocol}//${url.hostname}"`,
  );
}

function keyOf(source: JwtKeySource): { key: Uint8Array | JWTVerifyGetKey; defaultAlgorithms: string[] } {
  if ("secret" in source)
    return { key: new TextEncoder().encode(source.secret), defaultAlgorithms: ["HS256"] };
  const asymmetric = ["RS256", "ES256", "EdDSA"];
  if ("jwks" in source) return { key: createLocalJWKSet(source.jwks), defaultAlgorithms: asymmetric };
  assertJwksUrlAllowed(source.jwksUrl);
  return { key: createRemoteJWKSet(new URL(source.jwksUrl)), defaultAlgorithms: asymmetric };
}

function rolesOf(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(/\s+/).filter((v) => v !== "");
  return undefined;
}

function defaultMap(names: Required<JwtClaimNames>, requireTenant: boolean) {
  return (payload: JWTPayload): ResolvedIdentity => {
    const subject = payload[names.subject];
    if (typeof subject !== "string" || subject === "") {
      throw new JwtIdentityError("MISSING_SUBJECT", `token has no "${names.subject}" claim`);
    }
    const principal: Principal = { id: subject };
    const name = payload[names.name];
    if (typeof name === "string") principal.name = name;
    const roles = rolesOf(payload[names.roles]);
    if (roles != null) principal.roles = roles;
    const tenant = payload[names.tenant];
    if (typeof tenant === "string" && tenant !== "") return { principal, tenant };
    if (requireTenant) {
      throw new JwtIdentityError("MISSING_TENANT", `token has no "${names.tenant}" claim`);
    }
    return { principal };
  };
}

/**
 * Verifies a JWT (signature, exp/nbf, optional iss/aud) with jose and maps its claims to kohaku's
 * `Principal` (+ tenant). Nothing here touches capability tokens — that stays with the AuthzPort.
 */
export function createJwtIdentityResolver(options: JwtIdentityOptions): JwtIdentityResolver {
  if ("secret" in options.key) {
    if (Buffer.byteLength(options.key.secret, "utf8") < MIN_HMAC_SECRET_BYTES) {
      throw new Error(
        `key.secret must be at least ${MIN_HMAC_SECRET_BYTES} bytes (HS256 requires a strong shared secret)`,
      );
    }
  } else if (options.audience == null) {
    // jwks / jwksUrl mode: a JWKS-configured resolver typically talks to a third-party issuer that mints
    // tokens for other audiences too, so an unset `audience` here would accept a token never meant for
    // this service.
    throw new Error("audience is required when key is jwksUrl or jwks");
  }

  const { key, defaultAlgorithms } = keyOf(options.key);
  const algorithms = options.algorithms ?? defaultAlgorithms;
  const requireTenant = options.requireTenant ?? false;
  const map = options.mapClaims ?? defaultMap({ ...DEFAULT_CLAIMS, ...options.claims }, requireTenant);

  const resolve = async (token: string): Promise<ResolvedIdentity> => {
    let payload: JWTPayload;
    try {
      const verifyOptions = {
        algorithms,
        ...(options.issuer != null ? { issuer: options.issuer } : {}),
        ...(options.audience != null ? { audience: options.audience } : {}),
        clockTolerance: options.clockToleranceSeconds ?? 0,
      };
      const result = await jwtVerify(token, key, verifyOptions);
      payload = result.payload;
    } catch (e) {
      throw new JwtIdentityError("INVALID_TOKEN", "token verification failed", { cause: e });
    }
    return map(payload);
  };

  return {
    resolve,
    async fromAuthorizationHeader(header) {
      const token = bearerToken(header);
      if (token == null)
        throw new JwtIdentityError("MISSING_TOKEN", "no Bearer token in the Authorization header");
      return resolve(token);
    },
  };
}
