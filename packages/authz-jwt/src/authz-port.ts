import { createHmacAuthzPort } from "@kohaku-ui/authz-hmac";
import type { AuthzPort } from "@kohaku-ui/spec-core";
import { createJwtIdentityResolver, type JwtIdentityOptions, type JwtIdentityResolver } from "./identity.js";

export interface JwtAuthzOptions extends JwtIdentityOptions {
  /** Secret for the capability tokens kohaku issues per Spec (HMAC-SHA256, from @kohaku-ui/authz-hmac). */
  capabilitySecret: string;
  /** Default capability TTL in seconds (the host may override per issuance). Default 600. */
  capabilityTtlSeconds?: number;
}

export interface JwtAuthzPort extends AuthzPort {
  /** The resolver a host wires into its principal/tenant hooks (host-rest `auth` / `tenant`, MCP `resolvePrincipal`). */
  readonly identity: JwtIdentityResolver;
}

/**
 * AuthzPort for JWT / OIDC deployments. The two halves of the contract are deliberately separate:
 * capability tokens (issue / verify) are the existing HMAC scheme, unchanged; the identity resolver only
 * turns the caller's bearer JWT into a Principal + tenant for the host's own hooks. A capability is never a
 * JWT and a JWT is never a capability.
 */
export function createJwtAuthzPort(options: JwtAuthzOptions): JwtAuthzPort {
  const { capabilitySecret, capabilityTtlSeconds, ...identityOptions } = options;
  const capabilities = createHmacAuthzPort(
    capabilitySecret,
    capabilityTtlSeconds != null ? { ttlSeconds: capabilityTtlSeconds } : undefined,
  );
  const identity = createJwtIdentityResolver(identityOptions);
  return {
    identity,
    issueCapability: (principal, scopes, opts) => capabilities.issueCapability(principal, scopes, opts),
    verify: (token, req) => capabilities.verify(token, req),
  };
}
