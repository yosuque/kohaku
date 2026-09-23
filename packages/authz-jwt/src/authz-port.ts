import { createHmacAuthzPort, type RevokeCapabilityResult } from "@kohaku-ui/authz-hmac";
import type { AuthzPort, CapabilityRevocationStore } from "@kohaku-ui/spec-core";
import { createJwtIdentityResolver, type JwtIdentityOptions, type JwtIdentityResolver } from "./identity.js";

export interface JwtAuthzOptions extends JwtIdentityOptions {
  /** Secret for the capability tokens kohaku issues per Spec (HMAC-SHA256, from @kohaku-ui/authz-hmac). */
  capabilitySecret: string;
  /** Default capability TTL in seconds (the host may override per issuance). Default 600. */
  capabilityTtlSeconds?: number;
  /**
   * The store consulted for pre-expiry capability revocation, passed straight through to the underlying
   * HMAC port (see `@kohaku-ui/authz-hmac`'s `HmacAuthzOptions.revocations`). Defaults to a private
   * in-memory store; a multi-instance deployment should inject a shared store instead.
   */
  revocations?: CapabilityRevocationStore;
}

export interface JwtAuthzPort extends AuthzPort {
  /** The resolver a host wires into its principal/tenant hooks (host-rest `auth` / `tenant`, MCP `resolvePrincipal`). */
  readonly identity: JwtIdentityResolver;
  /**
   * Revokes a capability before its `exp`, delegating entirely to the underlying HMAC port
   * (`@kohaku-ui/authz-hmac`'s `revokeCapability`). Revocation applies only to the capability token; it
   * has no effect on the bearer JWT the identity resolver handles.
   */
  revokeCapability(token: string): Promise<RevokeCapabilityResult>;
}

/**
 * AuthzPort for JWT / OIDC deployments. The two halves of the contract are deliberately separate:
 * capability tokens (issue / verify) are the existing HMAC scheme, unchanged; the identity resolver only
 * turns the caller's bearer JWT into a Principal + tenant for the host's own hooks. A capability is never a
 * JWT and a JWT is never a capability.
 */
export function createJwtAuthzPort(options: JwtAuthzOptions): JwtAuthzPort {
  const { capabilitySecret, capabilityTtlSeconds, revocations, ...identityOptions } = options;
  const capabilities = createHmacAuthzPort(capabilitySecret, {
    ...(capabilityTtlSeconds != null ? { ttlSeconds: capabilityTtlSeconds } : {}),
    ...(revocations != null ? { revocations } : {}),
  });
  const identity = createJwtIdentityResolver(identityOptions);
  return {
    identity,
    issueCapability: (principal, scopes, opts) => capabilities.issueCapability(principal, scopes, opts),
    verify: (token, req) => capabilities.verify(token, req),
    revokeCapability: (token) => capabilities.revokeCapability(token),
  };
}
