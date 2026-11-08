---
"@kohaku-ui/domain-mcp": patch
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/spec-core": patch
"@kohaku-ui/data-binding": patch
---

domain-mcp: an unsigned `_limit` can no longer widen a read, and a write whose upstream call timed out is reported as "outcome unknown".

- `@kohaku-ui/domain-mcp`: `_limit` is outside the capability's signed ref and may only lower the signed `limit`, but a negative, zero or fractional value was forwarded as `Math.min(-1, signed)`, i.e. `-1`; an upstream that does `rows[:limit]` then returned more rows than the signed ref authorised. `coerceToolArguments` now requires `_limit` to be a positive safe integer (`"5.0"` and `"1e1"` stay accepted) and otherwise throws `McpArgumentError` (`argument "_limit": expected a positive integer`, still 404 `REF_NOT_FOUND` over REST). A write's `McpTimeoutError` now carries `code: "MCP_OUTCOME_UNKNOWN"` (exported as `MCP_OUTCOME_UNKNOWN`); a read's has no code.
- `@kohaku-ui/host-core`: new `OUTCOME_UNKNOWN_MESSAGE` and `isOutcomeUnknownError` (an Error whose `code` is or ends in `OUTCOME_UNKNOWN`); `classifyHostError` gains the `outcomeUnknown` kind (before the `typed` rule, so the error's own text, which names the upstream tool, is never shown) and `clientMessageFor` returns the fixed message for it.
- `@kohaku-ui/host-rest`: `POST /binding/action` answers such a write with **503 `INTERNAL`** and the fixed message `the action's outcome is unknown; verify before retrying` instead of 404 `REF_NOT_FOUND`, so the caller verifies before sending the same approval again (a stateless approval token would run the write twice). No new wire error code; the real error still reaches `onError`. Every other failed write stays 404.
- `@kohaku-ui/host-mcp-apps`: `kohaku_action` returns the same fixed message as its tool error (it came out as the generic internal-error text before).
- Python port: the same changes in `kohaku.domain_mcp`, `kohaku.host_core`, `kohaku.host_rest` and `kohaku.host_mcp`.
- Fix round: `_limit` and the signed `limit` must both be positive safe integers (a signed `0` / `-1` used to slip under `maxLimit`); a write's deadline is now always an `McpTimeoutError` even when the client rejects synchronously on abort; any other write failure that does not say the tool did not run (closed connection, failed send, transport error, the SDK's own timeout) is wrapped in the new `McpOutcomeUnknownError` (same code, original as `cause`), while a JSON-RPC error the server answered and a local pre-send error are re-thrown unchanged. Because of this wrapper an SDK message such as "Connection closed" no longer reaches the model over MCP.
- Minor for host-core / host-rest / host-mcp-apps: the `HostErrorClass` union widens (`outcomeUnknown`) and `POST /binding/action` answers 503 instead of 404 for such a write. SPEC gains ACT-OUT-001 [Draft, SHOULD]: the fixed message is the normative discriminator, no new wire field or `HostErrorCode`, and a client must not retry `/binding/action` on a 503 (pinned for `@kohaku-ui/data-binding`'s `invokeAction` by a test).
- `@kohaku-ui/spec-core`: the DomainPort doc now states the `*_OUTCOME_UNKNOWN` error-code convention host-core relies on. `@kohaku-ui/data-binding`: a comment on the no-retry guarantee only.
