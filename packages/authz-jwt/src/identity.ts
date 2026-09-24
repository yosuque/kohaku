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
  audience?: string | string[];
  /** Seconds of leeway on exp / nbf. Default 0. */
  clockToleranceSeconds?: number;
  /** Allowed `alg` values. Default: ["HS256"] for a secret, ["RS256", "ES256", "EdDSA"] for a JWK set. */
  algorithms?: string[];
  claims?: JwtClaimNames;
  /** Full override of the claims → identity mapping (the verified payload is passed in). */
  mapClaims?: (payload: JWTPayload) => ResolvedIdentity;
}

export type JwtIdentityErrorCode = "MISSING_TOKEN" | "INVALID_TOKEN" | "MISSING_SUBJECT";

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

function keyOf(source: JwtKeySource): { key: Uint8Array | JWTVerifyGetKey; defaultAlgorithms: string[] } {
  if ("secret" in source)
    return { key: new TextEncoder().encode(source.secret), defaultAlgorithms: ["HS256"] };
  const asymmetric = ["RS256", "ES256", "EdDSA"];
  if ("jwks" in source) return { key: createLocalJWKSet(source.jwks), defaultAlgorithms: asymmetric };
  return { key: createRemoteJWKSet(new URL(source.jwksUrl)), defaultAlgorithms: asymmetric };
}

function rolesOf(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") return value.split(/\s+/).filter((v) => v !== "");
  return undefined;
}

function defaultMap(names: Required<JwtClaimNames>) {
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
    return typeof tenant === "string" && tenant !== "" ? { principal, tenant } : { principal };
  };
}

/**
 * Verifies a JWT (signature, exp/nbf, optional iss/aud) with jose and maps its claims to kohaku's
 * `Principal` (+ tenant). Nothing here touches capability tokens — that stays with the AuthzPort.
 */
export function createJwtIdentityResolver(options: JwtIdentityOptions): JwtIdentityResolver {
  const { key, defaultAlgorithms } = keyOf(options.key);
  const algorithms = options.algorithms ?? defaultAlgorithms;
  const map = options.mapClaims ?? defaultMap({ ...DEFAULT_CLAIMS, ...options.claims });

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
