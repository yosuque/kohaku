---
"@kohaku-ui/host-mcp-apps": patch
---

Two MCP profile fixes (Python mirrored in the same change):

- MCP Tasks owner binding no longer uses the rate-limit key first. The owner is now the resolved principal's id when `resolvePrincipal` is wired, else `rateLimitKey`, else the session id, else `"anonymous"`, so two authenticated principals behind one NAT that share an IP-based `rateLimitKey` can no longer `tasks/get` (reading the result's bearer capability) or `tasks/cancel` each other's tasks.
- `${prefix}_action` and `${prefix}_resolve_binding` now take the rate limit after the capability verified and pass the capability's signed tenant to `rateLimiter.take` and `onRateLimited` (SPEC CAP-TEN-002), so a `tenants.<id>.rateLimits` rule applies over MCP. The principal component of the key is unchanged and `compose` stays checked as before. Behaviour change: a request whose capability fails verification no longer consumes or hits the limiter.
