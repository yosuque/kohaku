# 0014. An unknown action outcome answers 503 with a fixed message

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

`/binding/action` mapped every `DomainPort.invoke` failure to 404 `REF_NOT_FOUND`, and MCP collapsed it to a generic tool error. With `@kohaku-ui/domain-mcp`, which forwards a governed Action to an upstream MCP server, a write can time out, or its connection can drop after the request was sent. The write may then already have run upstream.

The post-merge Codex (gpt-6-astra) review (finding C11, and a follow-up during the fix) pointed out the consequences. The client was told "reference not found", and the user guide's claim that a timed-out write is reported as "effect is unknown" was false. With stateless approvals (the default), a client resending the same approval token can execute the write twice.

The question was how a host signals "the outcome is unknown; verify before retrying" without breaking the wire contract.

## Options considered

- **Option A**: add a new wire error code (a `HostErrorCode` such as `OUTCOME_UNKNOWN`), optionally with an `error.outcome` field.
- **Option B**: reuse 503 `INTERNAL` with a fixed, normative message, following the precedent of design.md #71 (`LLM_PROVIDER_UNAVAILABLE_MESSAGE`) and ACT-RD-001's fixed `gated operation is not readable`.
- **Option C**: keep the uniform 404 and only correct the documentation.

## Decision

Chosen: **Option B** (PR #134).

- **Classification**: a DomainPort signals an unknown outcome with an error whose string `code` ends in `_OUTCOME_UNKNOWN`. host-core's `classifyHostError` classifies it as `outcomeUnknown` (Python `outcome_unknown`). This convention is documented on the DomainPort contract in spec-core and in Python `python/kohaku/src/kohaku/spec/ports.py`. host-rest has no domain-mcp-specific branch.
- **REST**: `/binding/action` answers **503 `INTERNAL`** with `the action's outcome is unknown; verify before retrying` (exported as `OUTCOME_UNKNOWN_MESSAGE`).
- **MCP**: `kohaku_action` returns the same message as a tool error.
- **Error reporting**: the real error still reaches `onError`.
- **SPEC**: new **ACT-OUT-001** (SHOULD, [Draft]). The fixed message is the discriminator, and a client does not auto-retry `/binding/action` on 503. The `@kohaku-ui/data-binding` `invokeAction` no-retry behaviour is pinned by a test, and the conformance manifest grows to 18 SHOULD (55 total).
- **domain-mcp**:
  - A write that hits its deadline is always `McpTimeoutError` with `code: "MCP_OUTCOME_UNKNOWN"`, whichever of abort and reject wins the race.
  - Other failures after the request was sent are wrapped in `McpOutcomeUnknownError`, with the original as `cause`. These include, in TS, SDK `CONNECTION_CLOSED` / `SEND_FAILED` / `REQUEST_TIMEOUT`, fetch `TypeError` and `ECONNRESET`, and in Python, the SDK-local -32000 / -32001.
  - A JSON-RPC error answered by the server, and a local error raised before sending, are rethrown unchanged.
  - Reads are never wrapped. A read timeout keeps today's mapping.

### Rationale

- **Option A** is a protocol change touching the SPEC error table, the JSON Schemas, the client SDK, the Python mirror and every conformance implementation. That is too much for a condition that only one adapter can raise today.
- **Option B** has two existing precedents for a fixed message as the machine-readable discriminator. It needs no schema change, and it moves the response from "safe to retry"-looking 404 semantics to an explicit "verify first".
- **Option C** would keep reporting a possibly executed write as "not found", which invites a duplicate write.
- **The code-suffix convention** keeps adapter namespaces (`MCP_…`) while letting host-core classify the error without knowing the adapter.
- **Server-answered errors stay deterministic** (not wrapped) because the server has told us the outcome.

## Consequences (trade-offs)

- **Good**:
  - A possibly executed write is no longer reported as "not found".
  - SDK messages such as "Connection closed" no longer reach the model over MCP.
  - The convention lets any future DomainPort adapter opt in.
- **Costs / bad**:
  - `/binding/action` now has several 503 `INTERNAL` responses, told apart only by message: gate unavailable, capability verification unavailable, and outcome unknown. Only the last is unsafe to resend.
  - host-core, host-rest and host-mcp-apps take a minor bump: the `HostErrorClass` union is wider and the status changes from 404 to 503.
  - **Known limitation**: lineage records `action.invoked` before the call, and the unknown outcome goes only to `onError`. An approver reading lineage cannot see it. A dedicated lineage event is a follow-up.
- **Revisit when**: a second adapter needs the distinction, or a client must branch on it without string matching. At that point, promote it to a wire error code (Option A) through a protocol change.

## References

- PRs: #121 (domain-mcp), #134 (this decision)
- SPEC ACT-OUT-001; design.md #71 (fixed-message precedent) and #75
- [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.md): ACT-RD-001, the other fixed-message discriminator
- [ADR-0008](0008-mcp-write-tools-default-to-approve-tier.md): domain-mcp write tools
