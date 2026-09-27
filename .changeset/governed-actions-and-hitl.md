---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/authz-hmac": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/lineage": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/client": minor
"@kohaku-ui/data-binding": minor
"@kohaku-ui/renderer-core": minor
"@kohaku-ui/renderer-react": minor
"@kohaku-ui/renderer-wc": minor
"@kohaku-ui/mcp-renderer": minor
---

Add Governed Actions: Human-In-The-Loop tiers for `DomainPort` write operations (design.md #62/#63/#64;
SPEC §5's ACT-PRM-001/ACT-APR-001/ACT-CNF-001, LIN-ACT-001, §6.2's MCPAPP-ACT-001).

An operation may declare `tier` (`"auto"` (default) / `"confirm"` / `"approve"`) and `paramsSchema`
(kohaku's own closed JSON Schema subset — `type`, `properties`, `required`,
`additionalProperties: false`, `enum`, `minimum`/`maximum`, `minLength`/`maxLength`, `items`, `maxItems`,
`x-message`; deliberately no `pattern`, to avoid both ReDoS and a JS/Python regex-dialect mismatch).
`spec-core`'s `validateActionParams`/`assertValidActionParamsSchema` (env-neutral, dependency-free, pinned
byte-for-byte against the Python port via the cross-language golden) enforces the schema before
`DomainPort.invoke` ever runs, on every write surface alike: REST's `POST /binding/action`, MCP's
`${prefix}_action`, and the client-side `preflightAction` check `renderer-core` runs before either.

`"approve"`-tier actions are gated by a new stateless, short-lived HMAC-signed `ApprovalPort`
(`@kohaku-ui/authz-hmac`'s `createHmacApprovalPort`, `"kohaku-approval.v1."`-prefixed tokens, 300s default
TTL) bound to `(action, payloadHash, requesterId, tenant)`; self-approval is refused at issuance, and a
verification failure the host cannot classify is treated as a denial (fail-closed). An optional
`ApprovalStore` adds single-use enforcement. REST gains `POST /approvals` (mints a token as an authorized
approver, governance kind `action.approve`) and both the REST body and the MCP action tool's input gain
optional `confirmed`/`approval` fields; a gate failure is `422 ACTION_PARAMS_INVALID` / `403
APPROVAL_REQUIRED` on REST (with `error.issues`/`error.approval`) and the MCP structured-tool-error
equivalent.

A compose response optionally carries an **Action manifest** (REST's `actions?` on
`/compose`/`/events`/`event: spec`; MCP's `_meta["kohaku/actions"]`) mapping each governed action name to
`{tier, paramsSchema?, confirmMessage?}` — placed outside the `UISpec` itself, next to the capability, so
it never affects `specHash` or the cache key. `renderer-core`'s `preflightAction` consults it client-side
before a write round-trip; `renderer-react`/`renderer-wc`/`mcp-renderer` thread `confirm`/`requestApproval`
hooks through (`renderer-react` ships a `globalThis.confirm`-backed default for the `"confirm"` tier; there
is no framework-neutral default for `"approve"`, so that tier stays gated until a product wires its own
hook). `@kohaku-ui/client`/`@kohaku-ui/data-binding` gain typed `ACTION_PARAMS_INVALID`/`APPROVAL_REQUIRED`
error codes and `confirmed`/`approval` request options. A host that records action outcomes to lineage does
so under a distinct `action.*` event family (`action.invoked`/`action.denied`/`action.approvalRequested`/
`action.approved`), carrying `payloadHash` but never the payload's own field values.

The Python port (`python/kohaku`) mirrors the full surface (`kohaku.spec.action_params`,
`kohaku.host_core.action_gate`/`action_audit`, `POST /approvals`, the MCP action-tool gate), and
`apps/sample-api` / `python/examples/sales-api` demonstrate both tiers end to end (`annotate`: confirm,
`publish`: approve) — see the [user guide](../docs/user-guide.md)'s "Governed actions: tiers" section.
