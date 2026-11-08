# 0016. The MCP data-plane rate limit is taken after capability verification

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

SPEC CAP-TEN-002 says that a host taking a rate limit on the data plane SHOULD do so after capability verification, keyed by the verified tenant (and principal). It names the MCP counterparts explicitly. REST already did this (`authorizeAndRateLimit`: verify, then take).

MCP checked the limit for `action` and `resolve` before verifying the capability, and called `take({ principal, routeClass })` with no tenant. A rule under `tenants.<id>.rateLimits` was therefore never applied over MCP. A capability issued through REST and replayed over MCP got the default limits instead of the tenant's stricter ones. This was post-merge Codex (gpt-6-astra) finding C1, confirmed by a verifier.

Moving the check after verification raised a second Codex concern. An invalid capability no longer reaches the limiter, so a flood of invalid capabilities is not throttled by the host's limiter at all.

## Options considered

- **Option A**: for `action` / `resolve`, take the limit after verification with `{ tenant: <verified tenant>, principal: <same MCP key as before>, routeClass }`. Pass the tenant to `onRateLimited`. Keep `compose` checked as before. Document that a pre-verification flood must be bounded by a coarse IP limiter in front of the HTTP host, as REST already documents.
- **Option B**: Option A, plus keep a second, coarse limiter check before verification.
- **Option C**: keep the pre-verification, tenant-less check.

## Decision

Chosen: **Option A** (PR #131), in TS and Python.

- The principal part of the key is unchanged and is not switched to the capability's `sub`.
  - Without `resolvePrincipal`, the sub is the constant default principal, so every caller would share one bucket.
  - A REST-issued capability replayed over MCP carries the REST sub.
  - The difference from CAP-TEN-002's "verified tenant and subject" is deliberate and documented. It is a SHOULD-level choice.
- An invalid capability never reaches the limiter or `onRateLimited`. Before verification, MCP is bounded only by the payload cap and by HMAC verification. The user guide (EN and JA) says to put a coarse IP or route limiter in front of the host.

### Rationale

- Option A matches REST exactly, so one capability gets the same limits on both profiles, and CAP-TEN-002 holds for MCP.
- Option B would count every valid call twice against the same limiter and make MCP diverge from REST. The coarse pre-verification protection belongs in front of the host, where REST already expects it.
- Option C leaves tenant-specific limits unenforceable over MCP.

## Consequences (trade-offs)

- **Good:**
  - A tenant-only rate-limit rule is enforced over MCP.
  - `onRateLimited` reports the tenant.
  - The behaviour matches REST.
- **Costs / bad:**
  - Deployments that relied on an IP-keyed `rateLimitKey` to throttle invalid-capability floods over MCP lose that protection. They need an external limiter, which the changeset and user guide call out.
  - Before verification, MCP does unthrottled work: parse, payload size check, `resolvePrincipal` and HMAC verify.
- **Revisit when:** the host gains a built-in coarse pre-auth limiter for both profiles.

## References

- PR: #131
- SPEC CAP-TEN-002; [ADR-0004](0004-capability-tenant-is-authoritative-on-the-data-plane.md) (the capability tenant is authoritative)
- [ADR-0015](0015-mcp-task-owner-is-the-authenticated-principal.md): the task-owner decision from the same fix
