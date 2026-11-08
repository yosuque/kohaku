# 0008. A wrapped MCP server's write tools default to the approve tier

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: design

## Context and problem

`@kohaku-ui/domain-mcp` (Python mirror `kohaku.domain_mcp`) turns an existing MCP server into a kohaku `DomainPort`, so that a team with an MCP server can put kohaku's governance in front of it. The package has to decide which tools are reads and which are writes using only what MCP exposes, which is a few annotations that the server itself supplies. Writes from the server should go through kohaku's approval gate and audit trail instead of being called directly. MCP also exposes no data version, and an MCP tool's `inputSchema` is richer than the closed `ActionParamsSchema` subset the gate validates.

## Options considered

- **Option A**: classify by one hint. `annotations.readOnlyHint === true` makes a tool a `query://` operation; everything else, including a tool with no annotations (the MCP default for the hint is false), is an Action with `tier: "approve"`. `tierFor` overrides the tier.
- **Option B**: treat the hint as authoritative, with no way to override the classification. The wp-o5a review rejected this (finding S-2): the hint is untrusted, so it added an `isReadOnly(tool)` override and a prominent "trusted servers only" notice.

## Decision

Chosen: **Option A**, with `isReadOnly`, `include` and `tierFor` as explicit overrides.

- **Reads**: `createMcpIntents` makes an Intent only for read-only tools, so a write tool cannot be the target of a read capability (which is issued only for an Intent's resolved refs). Query results become `TabularData` (from `structuredContent`, else the first JSON text block; a list, `{rows}`, or a single wrapped list).
- **Writes**: the tool's `inputSchema` is projected onto the closed `ActionParamsSchema` subset. Annotations, `pattern` and `format` are dropped and reported through `onSchemaProjection`, and the count of dropped constraints is appended to the approver-facing operation description. A nullable two-branch `anyOf` (Pydantic's `Optional[X]`) becomes an optional property. A schema that uses any other `anyOf` / `oneOf` / `$ref`, `additionalProperties: true` or unknown keywords is omitted entirely, and the approver then judges the raw payload.
- **Arguments**: ref parameters are strings, so they are coerced by the `inputSchema` type; `_cursor`, `_sort` and `_dir` are never forwarded. `_limit` is outside the capability's signed ref, so it can only lower the signed `limit` (the minimum wins), and `maxLimit` (1000) caps the result. A coercion error carries the code `MCP_ARGUMENT_INVALID` (not the action path's `ACTION_PARAMS_INVALID`) and, like every `domain.invoke` failure on a read, reaches REST as `404 REF_NOT_FOUND`.
- **Limits**: `callTimeoutMs` 30 s (aborted, never retried; a timed-out write is reported as "effect unknown"), `maxRows` 10 000, `maxResultBytes` 10 MiB, tool listing capped at 100 pages. Tool names must match `[A-Za-z0-9_.-]{1,128}`; copies that disagree on read-only versus write are all dropped (fail closed).
- **Data version**: `mcpDataVersion` is a time bucket (`mcp:<floor(now / 300 s)>`, overridable), which the port also stamps on the data it returns.
- **Out of scope on purpose**: following `tools/list_changed` (the operation index is memoized; restart to refresh), and forwarding the caller's principal to the MCP server (the client transport authenticates, so there is one upstream credential). The MCP client is passed in as a structural `McpToolClientLike`, so the package never imports the SDK.
- The projection, coercion, tabular conversion and shape inference are pure functions pinned across TS and Python by the cross-language golden.

### Rationale

- Failing safe: a server that omits the hint gets the MCP default of false, so its tool is treated as a write and needs an approval; only an explicit `readOnlyHint: true` (or an `isReadOnly` override) makes a tool a read.
- Omitting a schema that cannot be projected, instead of approximating it, keeps the gate from validating against a schema that does not mean what the server's does. The cost is that the approver sees the raw payload.
- `_limit` and `maxLimit` keep a URL-level parameter from widening a signed read.
- The coercion error keeps the existing host-rest convention that `domain.invoke` failures on a read are 404 with the body hidden. Mapping typed domain errors to a 4xx is a separate Port-contract decision.

## Consequences (trade-offs)

- Good: writes from a wrapped MCP server get the approval gate and the audit trail. The e2e with a real in-process MCP server covers compose, resolve, a write answered `403 APPROVAL_REQUIRED`, and the successful call after `POST /approvals`, with the lineage events checked.
- Costs / bad:
  - `readOnlyHint` is an untrusted hint. A server that marks a write tool read-only bypasses the approve gate, so the adapter is documented as trusted-servers-only, and `isReadOnly` or `include` let the integrator control the classification. Separately, a write tool whose `tierFor` returns `"auto"` is readable through a read ref and is not protected by the host-level read guard of [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.md); the documentation says not to do that.
  - Closing objects with `additionalProperties: false` can make the gate stricter than the server.
  - A Spec composed just before a bucket boundary is stale once, and a write does not change the version until the next bucket.
  - No per-caller authorization upstream, and no refresh without a restart.
  - Coercion errors reach REST as 404, not 4xx validation errors.
- Revisit when: the mapping of typed domain errors to a 4xx becomes a Port-contract decision (recorded as an ADR candidate in the wp-o5a review).

## References

- PR: #121 (TS and Python); the package README states the limits and the trust requirement
- design.md decision #75
- [ADR-0006](0006-data-plane-read-path-never-runs-gated-operations.md)
