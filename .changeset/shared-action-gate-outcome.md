---
"@kohaku-ui/host-core": patch
"@kohaku-ui/host-rest": patch
"@kohaku-ui/host-mcp-apps": patch
---

The MCP `kohaku_action` tool now audits an undeclared action as `action.denied`, exactly as REST's `POST /binding/action` does (SPEC MCPAPP-ACT-001, LIN-ACT-001); the undeclared-action check moved after capability verification and now reads the same operation index the gate uses, and the capability write-scope filter is derived from that index instead of a second `listOperations()` read. host-core gains `recordActionGateResult` / `recordUndeclaredActionDenial` (the shared gate-result audit trail and the confirmation / approval-token messages) and `allowedActionsFromIndex`, which both hosts now call (design.md decisions 62/63).

Both hosts also build the operation index eagerly at attach and report a failure (for example a `paramsSchema` outside the closed subset) through `onError` with endpoint `attach.operationIndex`, instead of only at the first invoke.

An operation whose `paramsSchema` is outside the closed subset no longer fails the whole operation index: `OperationIndexEntry` gains `schemaError`, the operation stays declared (its capability write scope and the undeclared-action check are unaffected, on REST and MCP alike), it is omitted from the `actions` manifest, and invoking it fails closed (REST 500, MCP tool error) while other operations keep working. host-core also exports `validateOperationIndex`, which both hosts call at attach.
