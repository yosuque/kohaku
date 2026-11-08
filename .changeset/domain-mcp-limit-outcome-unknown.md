---
"@kohaku-ui/domain-mcp": patch
"@kohaku-ui/host-core": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host-mcp-apps": patch
---

domain-mcp: an unsigned `_limit` can no longer widen a read, and a write whose upstream call timed out is reported as "outcome unknown".

- `@kohaku-ui/domain-mcp`: `_limit` is outside the capability's signed ref and may only lower the signed `limit`, but a negative, zero or fractional value was forwarded as `Math.min(-1, signed)`, i.e. `-1`; an upstream that does `rows[:limit]` then returned more rows than the signed ref authorised. `coerceToolArguments` now requires `_limit` to be a positive safe integer (`"5.0"` and `"1e1"` stay accepted) and otherwise throws `McpArgumentError` (`argument "_limit": expected a positive integer`, still 404 `REF_NOT_FOUND` over REST). A write's `McpTimeoutError` now carries `code: "MCP_OUTCOME_UNKNOWN"` (exported as `MCP_OUTCOME_UNKNOWN`); a read's has no code.
- `@kohaku-ui/host-core`: new `OUTCOME_UNKNOWN_MESSAGE` and `isOutcomeUnknownError` (an Error whose `code` is or ends in `OUTCOME_UNKNOWN`); `classifyHostError` gains the `outcomeUnknown` kind (before the `typed` rule, so the error's own text, which names the upstream tool, is never shown) and `clientMessageFor` returns the fixed message for it.
- `@kohaku-ui/host-rest`: `POST /binding/action` answers such a write with **503 `INTERNAL`** and the fixed message `the action's outcome is unknown; verify before retrying` instead of 404 `REF_NOT_FOUND`, so the caller verifies before sending the same approval again (a stateless approval token would run the write twice). No new wire error code; the real error still reaches `onError`. Every other failed write stays 404.
- `@kohaku-ui/host-mcp-apps`: `kohaku_action` returns the same fixed message as its tool error (it came out as the generic internal-error text before).
- Python port: the same changes in `kohaku.domain_mcp`, `kohaku.host_core`, `kohaku.host_rest` and `kohaku.host_mcp`.
