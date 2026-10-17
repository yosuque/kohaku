---
"@kohaku-ui/host-core": patch
"@kohaku-ui/host-mcp-apps": patch
"@kohaku-ui/lineage": patch
"@kohaku-ui/storage-postgres": patch
"@kohaku-ui/storage-memory": patch
"@kohaku-ui/semantic-llm": patch
"@kohaku-ui/cli": patch
---

Review-driven fixes across the host, lineage, storage and CLI packages:

- `@kohaku-ui/host-mcp-apps`: an Action gate that cannot decide (the operation index failing to build, or `ActionGate.check` / `ApprovalPort.verifyApproval` throwing) is now audited as an `action.denied` lineage event through host-core's `recordActionGateUnavailableDenial`, as the REST profile already did, and the tool error carries the fixed `action gate unavailable` message.
- `@kohaku-ui/host-core`: the console error reporter's non-debug line now names the error type and, when present, its `code` / provider / model (`LlmError[PROVIDER anthropic/...]: ...`) so an operator can tell a provider outage from any other failure; the cause chain and stack stay debug-only.
- `@kohaku-ui/lineage`: fixation proposals skip `view.composed` records that carry `provenance.fallback` (a fallback Spec can never be fixated, so it no longer shows up as a 100%-stable candidate); the generic promotion `act()` path keeps "audit record first, snapshot second" and now documents why (a lost `component.reviewed` must never let a retried approve() publish without the human-approval evidence); re-approving a published candidate whose draft or html is missing now fails fast instead of passing `undefined` to the projection.
- `@kohaku-ui/storage-postgres`: the migration advisory-lock wait is bounded (`MIGRATION_LOCK_WAIT_MS`, 60 s) and rejects with the lock key instead of hanging `ready()` forever; the README documents that Spec-cache rows stored without `ttlSeconds` are never swept.
- `@kohaku-ui/storage-memory`: `listLineage` scans from the tail and stops after `limit` matches instead of filtering the whole log.
- `@kohaku-ui/semantic-llm`: an empty intent catalog now fails with "the intent catalog is empty" rather than "does not match any intent".
- `@kohaku-ui/cli`: the `kohaku init` REST server drains gracefully on SIGINT / SIGTERM (`/api/health` turns 503 while shutting down, `KOHAKU_SHUTDOWN_GRACE_MS` bounds the drain, a `start` script is generated), the `init --mcp` server validates `KOHAKU_SHUTDOWN_GRACE_MS`, the `scaffold ports` hints mention the capability secret and the full install line, and the package README lists every command.
