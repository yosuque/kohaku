# 0015. The MCP task owner is the authenticated principal

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

The MCP Tasks extension (opt-in, `tasksEnabled`) binds each background task to an owner. Only the owner may `tasks/get` it, which returns the result including its bearer capability in `_meta`, or `tasks/cancel` it. The owner key came from `mcpRateLimitKey`, and that function prefers the product's `rateLimitKey` over `principal.id`.

The documented example of a `rateLimitKey` is the client IP. With that configuration, two different authenticated principals behind one NAT shared an owner, so each could read or cancel the other's tasks once it learned the task id.

The post-merge Codex (gpt-6-astra) review raised this as finding C12. An independent verifier reproduced it in Python, and the TS code followed the same logic.

## Options considered

- **Option A**: a dedicated owner key, with reversed priority:
  1. `principal.id`, when `resolvePrincipal` is wired and resolves a principal other than the default one
  2. else `rateLimitKey`
  3. else the session (TS `sessionId`, Python the connection id)
  4. else `"anonymous"`
- **Option B**: always use `principal.id`.
- **Option C**: keep the rate-limit key and document the risk.

## Decision

Chosen: **Option A** (PRs #120 → #131), in TS (`mcpTaskOwnerKey`) and Python (`_mcp_task_owner_key`).

- The owner key is used at task creation and in `tasks/get` / `tasks/cancel`.
- `mcpRateLimitKey` is unchanged and used only for rate limiting.
- When `resolvePrincipal` resolves the default (guest or anonymous) principal, the owner falls back to the rate-limit key, then the session. Guests therefore do not merge into one owner.
- `resolvePrincipal` must return a distinct id per caller. This is documented in the types, `tasks.ts` / `tasks.py`, and design.md (EN and JA).

### Rationale

- The authenticated identity is the strongest key the host has. A rate-limit key is a throttling bucket and may be deliberately shared, as with an IP or a tenant.
- Option B would make things worse without `resolvePrincipal`: `principal.id` is then the constant anonymous id, and every caller would share one owner.
- The guest fallback came from review. A product whose `resolvePrincipal` returns a shared guest principal for unauthenticated calls would otherwise have lost the per-IP separation it had before.
- Option C leaves a cross-user read of bearer capabilities in a documented configuration.

## Consequences (trade-offs)

- **Good:**
  - Two principals sharing a NAT key are refused get and cancel on each other's tasks.
  - The same principal keeps access after reconnecting from another IP, which it previously lost.
- **Costs / bad:**
  - Without `resolvePrincipal`, ownership is still only as strong as the rate-limit key or session, as before.
  - A `resolvePrincipal` that returns a shared non-default id still merges those callers. The contract says not to do that.
- **Revisit when:** MCP gains a standard per-request identity that the host can rely on without a product `resolvePrincipal`.

## References

- PRs: #120 (MCP Tasks, task-owner binding), #131 (this decision)
- design.md, MCP Tasks section
- [ADR-0016](0016-mcp-data-plane-rate-limit-is-taken-after-capability-verification.md): the related rate-limit ordering decision from the same fix
