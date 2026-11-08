---
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
---

The data-plane read path no longer executes a governed Action (SPEC ACT-RD-001, [Draft], SHOULD). `GET /binding/resolve`, the MCP `${prefix}_resolve_binding` tool and the MCP initial-data pre-resolution now look the operation a `query://` ref names up in the memoized operation index before `DomainPort.invoke`, and refuse one whose declared `tier` is `"confirm"` or `"approve"`. Before, a read capability for such a ref ran the operation with no confirmation, no approval and no audit, because the read path never passed through the action gate; only the assumption that an Intent never builds such a ref prevented it.

- `host-core`: new `isGatedOperation(entry)`, `runGatedReadGuard(input)` and `GATED_READ_MESSAGE`. The guard returns `readable` / `gated` / `indexUnavailable` for the host to map onto its own wire, and audits the refusal fail-open as `action.denied` (reason `gated operation is not readable`, the operation's tier).
- `host-rest`: `/binding/resolve` answers `403 CAPABILITY_DENIED` (`gated operation is not readable`) for a gated operation. Behaviour change: when `DomainPort.listOperations()` cannot be read, the route now fails closed with `503 INTERNAL` (`action gate unavailable`); it used to consult no index at all. The guard runs after the capability verified and the rate limit was taken.
- `host-mcp-apps`: `${prefix}_resolve_binding` returns a tool error (`capability denied: gated operation is not readable`, or `operation index unavailable`). The initial-data pre-resolution skips a gated ref (and an unreadable index skips every ref, reported to `onError`); with `legacyUiResource` the snapshot for a Spec that binds data to a gated operation is dropped, as for any ref that does not resolve.
- Tier-less operations, tier `"auto"` and operations `listOperations()` does not list stay readable, so a host that declares no gated operations is unaffected. The Python port (`kohaku.host_core`, `host_rest`, `host_mcp`) has the same behaviour.
