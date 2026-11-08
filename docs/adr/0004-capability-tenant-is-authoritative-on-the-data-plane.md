# 0004. The capability token's tenant is authoritative on the data plane

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: design

## Context and problem

Under `KOHAKU_AUTHZ=jwt`, the REST data plane (`/binding/resolve`, `/binding/action`) is deliberately outside the JWT middleware, because what travels in `Authorization` there is a capability token, not a JWT. As a result `deps.auth` and `deps.tenant` resolved nothing on `/binding/*`, which was a gap left by the 2026-10-17 review. Three things followed. An `"approve"`-tier Action could never run: the approval token is bound to the approver's tenant (design.md #63), while the invoke carried no tenant. The audit records had no tenant. And the `/binding/*` rate limit was keyed by the anonymous demo principal, so every caller shared one bucket.

The capability is the one artifact that already crosses the compose / data-plane boundary carrying the caller's identity, so the question was where the tenant should live and whose word wins when the capability and the request disagree.

## Options considered

- **Option A**: add an optional, signed `tenant` claim to the capability token, issued from the tenant the host's own request resolution produced. The data plane treats the capability's tenant as authoritative, and denies a request whose separately resolved tenant differs.
- **Option B**: make the JWT resolver tolerate non-JWS tokens, so that the data plane could resolve a tenant from `Authorization` like every other route. design.md #76 rejects this because it would blur the rule that a capability is never a JWT.
- **Option C**: keep resolving the tenant from the request and, on a mismatch with the capability, reconcile by trusting one side. design.md #76 rejects both directions: a request header is exactly what an attacker controls, so a mismatch is denied rather than reconciled.

A related choice is the strength of the requirement in the SPEC. The implementation plan worded the data-plane half as MUST; the implementation did not adopt that and uses SHOULD (see Rationale).

## Decision

Chosen: **Option A**

- **Token**: an optional signed `tenant` claim (the HMAC payload becomes `{sub, scopes, exp, jti, tenant?}`). `AuthzPort.issueCapability(principal, scopes, { ttlSeconds?, tenant? })`, `VerifyResult.tenant?` and `InvocationContext.tenant?` are additive. The claim is a short identifier (at most 256 characters, no control characters). An invalid value throws on issue and is a malformed payload on verify, as is an explicit `null`; an empty value means no tenant.
- **Issuance**: REST binds the tenant its own request resolution produced, never one in the body, on `/compose`, `/events`, `/compose/stream` (the skeleton and the final event) and the promotion preview capability.
- **Data plane**: on `/binding/resolve` and `/binding/action` the tenant is `verdict.tenant`. A different `deps.tenant` is `403 CAPABILITY_DENIED`. A tenant-less capability falls back to `deps.tenant`, so tokens issued before this change stay valid.
- **Rate limit**: the `/binding/*` limit moved from the path middleware into the handlers, after verification, keyed by `(capability tenant, capability sub, routeClass)`. The bearer's presence is checked before the body is parsed.
- **MCP**: the MCP profile still resolves and issues no tenant of its own, but its data-plane tools pass the tenant a verified capability binds to `domain.invoke`, to the action gate (so to the approval binding) and to the audit. A capability minted by REST and replayed on MCP therefore keeps its tenant.
- **Strictness**: `createHmacAuthzPort({ requireTenant })` and `createJwtAuthzPort({ requireCapabilityTenant })` refuse tenant-less tokens. sample-api turns the requirement on under `KOHAKU_AUTHZ=jwt` unless `KOHAKU_JWT_REQUIRE_TENANT=0`; sample-mcp, which resolves no tenant, leaves it off.
- **SPEC**: CAP-TEN-001 (issuance) and CAP-TEN-002 (data plane), both SHOULD [Draft].

### Rationale

- The tenant goes into the capability because that is the single place identity already has to be carried across the compose / data-plane boundary. It fixes the approve-tier failure, the missing audit tenant and the shared rate-limit bucket together, without changing how the JWT middleware treats tokens.
- The signed value, not the request header, is authoritative. A mismatch is denied in both directions (fail-closed). A tenant-less token still works, so rolling the issuer forward invalidates nothing.
- Rate limiting after verification is what makes the key trustworthy.
- The requirements are SHOULD rather than MUST because the MCP profile resolves no tenant (the decision deferred in design.md #63) and legitimately issues tenant-less capabilities. Resolving a tenant on MCP stays a separate decision, which matches the maintainer's instruction that MCP only carries the claim.

## Consequences (trade-offs)

- Good: an approve-tier Action now runs end to end under the JWT scheme (pinned by the jwt e2e). Audit records carry the tenant, and the `/binding/action` rate-limit key is the JWT subject plus the tenant. The change is additive: a tenant-less token, a host without `deps.tenant`, and a port that ignores the option behave as before.
- Costs / bad:
  - Unauthenticated floods on `/binding/*` are bounded only by `bodyLimit`, and they now show up as 401, 403 or 400 instead of 429.
  - The Python `AuthzPort.issue_capability` Protocol gained a `tenant` keyword, so a custom Python port written against the old signature fails type checking. At runtime the host inspects the signature once and issues without the tenant, reporting once through `on_error` (`capability.tenant_unsupported`); the binding is silently absent until the port is upgraded.
  - MCP still issues tenant-less capabilities.
  - `KOHAKU_JWT_REQUIRE_TENANT=0` is single-tenant operation and drops the capability requirement as well, so each profile needs its own capability secret there. Enabling the requirement is a two-step rollout: upgrade every issuer first.
- Revisit when: the MCP profile resolves a tenant (or all supported profiles issue tenant-bound capabilities), at which point the data-plane half could be promoted to MUST; and if the coupling of `KOHAKU_JWT_REQUIRE_TENANT=0` to the capability requirement should get its own variable (both were left open in the wp-e8a report).

## References

- PR: #122 (the change, TS and Python)
- design.md decision #76 (and #63 for the MCP tenant decision); SPEC §5 CAP-TEN-001 / CAP-TEN-002
- [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.md): the other data-plane guard added in the same run, which relies on the verified principal and tenant for its audit record
