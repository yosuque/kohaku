# 0006. The data-plane read path never runs a confirm/approve operation

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: design

## Context and problem

The data-plane read path (`GET /binding/resolve`, the MCP `${prefix}_resolve_binding` / `kohaku_resolve_binding` tools, and the MCP initial-data pre-resolution) calls `DomainPort.invoke` without passing through the action gate. Until now the only thing keeping a `query://` read from running a write was the assumption that an Intent never builds such a ref. The wp-o5a review (finding S-1) showed the gap: a ref naming an `"approve"`-tier operation under a read capability ran it with no confirmation, no approval and no audit. The capability binds the ref string, not the operation's tier, so a hand-written Intent that points at a write tool, or a hallucinated or injected `$ref` in a generated Spec, is enough.

## Options considered

- **Option A**: a host-level guard on the read path. Before `DomainPort.invoke`, look the ref's operation up in the memoized `OperationIndex` and refuse one whose descriptor tier is `"confirm"` or `"approve"`.
- **Option B**: rely on the existing assumption and document it. This is what wp-o5a did inside its own scope: the package README states that `createMcpIntents` emits Intents for read-only tools only and that hand-written Intents must never point at action operations.
- **Option C**: variant of A that also refuses operations absent from `listOperations()`. The wp-x1 report records this as the alternative: it would break every host whose `listOperations()` omits query operations.

## Decision

Chosen: **Option A**, with an operation absent from the index staying readable.

- host-core owns one shared predicate and guard (`isGatedOperation`, `runGatedReadGuard`, and `createGatedReadGuard` for a pre-resolution). The outcome (`readable` / `gated` / `schemaInvalid` / `indexUnavailable`) is mapped by each host onto its own wire. SPEC ACT-RD-001, SHOULD [Draft].
- **Refusals**: REST answers `403 CAPABILITY_DENIED` (message `gated operation is not readable`). An unreadable index fails closed: REST `503 INTERNAL` (`action gate unavailable`), MCP a plain tool error. A pre-resolution skips the ref and the compose result stays successful. An operation whose `paramsSchema` is invalid (`schemaError`) is refused as the action path refuses it (REST 500, MCP tool error); a gated operation with a bad schema is refused as gated first.
- **Audit**: a refusal is recorded fail-open as `action.denied` with the descriptor's tier and the reason `gated operation is not readable`. The guard runs after the capability verified, so the record carries the verified principal and tenant.
- **Still readable**: a tier-less operation, tier `"auto"`, and an operation that `listOperations()` does not list.
- **Pre-resolution**: one guard per pre-resolution, so the index is read once and an unreadable index is reported and audited once. Refused refs are returned (`denied`), so a snapshot neither re-audits them nor treats them as a bounded-deadline failure; it throws `SNAPSHOT_REF_NOT_READABLE`.
- **`DomainPort` invariants** the guard relies on, written into the spec-core JSDoc, the Python Protocol and the SPEC: `invoke` dispatches on the exact operation name, and every side-effecting operation is listed with its tier.

### Rationale

- Enforcing at the one point every read crosses, off the same memoized index the action gate already consults, costs a map lookup per read and needs no change to the wire shape or the `DomainPort`.
- An operation absent from the index stays readable because read refs name query operations that a `DomainPort` need not list, and nothing there declares a tier to enforce; refusing them would break every existing host (the rejection of Option C).
- An unreadable index fails closed, matching ACT-APR-001 on the action path: a read that cannot be classified is exactly the case the guard exists for.
- SHOULD rather than MUST while [Draft], like CAP-TEN-002 ([ADR-0004](0004-capability-tenant-is-authoritative-on-the-data-plane.md)).

## Consequences (trade-offs)

- Good: a hallucinated, injected or hand-written read ref can no longer execute a confirm- or approve-tier operation, in REST, MCP and the MCP initial-data pre-resolution. A host that declares no gated operations behaves as before.
- Costs / bad:
  - A `listOperations()` outage now also takes reads down (503). Before, only writes and the actions manifest were affected.
  - The guard knows only listed operations. If a `tierFor` override returns `"auto"` for a write tool, that tool becomes readable through a read ref. This is documented in the domain-mcp README, the user guide and python/README, and the instruction is not to do it (see [ADR-0008](0008-mcp-write-tools-default-to-approve-tier.md)).
  - A compose whose Spec binds data to a gated operation embeds nothing for it. With `legacyUiResource` its snapshot is dropped (`SNAPSHOT_REF_NOT_READABLE`, reported fail-open) and `render_snapshot` is a tool error.
- Revisit when: promoting ACT-RD-001 to MUST, or extending the guard to every operation that declares a tier. Both were left open as ADR candidates in the wp-x1 report.

## References

- PR: #124 (TS and Python); the finding is S-1 of the wp-o5a review, PR #121
- design.md decision #77; SPEC §5 ACT-RD-001
- [ADR-0004](0004-capability-tenant-is-authoritative-on-the-data-plane.md), [ADR-0008](0008-mcp-write-tools-default-to-approve-tier.md)
