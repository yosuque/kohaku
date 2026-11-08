---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/storage-memory": minor
"@kohaku-ui/storage-redis": minor
"@kohaku-ui/storage-postgres": minor
"@kohaku-ui/lineage": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/host-mcp-apps": minor
"@kohaku-ui/host": minor
---

`StoragePort` gains an optional **compare-and-set**, so several host instances sharing one redis / postgres no longer silently lose each other's promotion-state and fixation updates (SPEC Appendix 12, REST-CONF-001 [Draft], design.md #79).

- **spec-core**: `PromotionState.revision?` (also in `PromotionStateSchema` / `spec/schemas`), `StoragePort.supportsCompareAndSet?: true`, a tri-state `expectedRevision` option on `putPromotionState`, `putFixation` and `deleteFixation` (omitted = unconditional, `null` = must not exist, string = must equal), the new `StorageConflictError` (`code: "STORAGE_CONFLICT"`) a mismatch throws without writing, and the `CONFLICT` `HostErrorCode`, plus the `singleProcess` marker. Adapters that do not declare the extension may keep ignoring the option, so existing adapters and fake ports stay valid. The batch `putPromotionStates` stays unconditional, so on a port that declares the extension the lineage service writes bulk nominations one candidate at a time, conditional on the revision the scan loaded, and skips a candidate that lost the race (no `component.nominated` for it) instead of rolling back an approve another instance recorded.
- **storage-memory / storage-redis / storage-postgres**: memory, redis and postgres declare it. The file port honors `expectedRevision` (against the snapshot re-read inside its in-process lock) but does **not** declare `supportsCompareAndSet` — its lock does not span processes, so two processes sharing a data directory can still lose updates — and both it and memory mark themselves `singleProcess: true`. redis uses `WATCH` / `MULTI` / `EXEC` (no Lua) on a dedicated connection it opens lazily from the shared client (offline queue and auto-resend off; a reconnect between WATCH and EXEC is refused as a conflict; close() closes it, even for an injected client; the ACL needs `WATCH` / `UNWATCH`); postgres uses one conditional `UPDATE` / `INSERT ... ON CONFLICT DO NOTHING` / `DELETE` on the payload's JSON `revision` (SQLSTATE `40001` also maps to the conflict), with no schema change. `@kohaku-ui/port-contracts` gets an opt-in `requireCompareAndSet` case group.
- **lineage**: every promotion snapshot write now carries a fresh `revision` and is conditional on the one the candidate was loaded with; `act()` re-reads the stored revision right before recording its audit event and throws `StorageConflictError` if it moved. Fixation `unfixate` / `invalidate` / `refreshFingerprint` / `replace` pass the revision they read (`fixate` stays an unconditional human overwrite). The persisted promotion state now has a `revision` key.
- **host-core / host-rest / host-mcp-apps**: `StorageConflictError` is answered with `409 CONFLICT` (REST also reports it to `onError` under `storage.conflict`; the self-heal `invalidate` / `refreshFingerprint` treat a lost race as a silent no-op) and the fixed message `the resource was modified concurrently; reload and retry` (`STORAGE_CONFLICT_MESSAGE`; a new `conflict` kind of `classifyHostError`), never retried inside the host; MCP returns the same message as a tool error; `applyCatalogMigration` reports a lost race as a skipped step.
- **host**: `createKohakuHost` warns once when a custom `storage` declares neither `supportsCompareAndSet` nor `singleProcess`.
- **Upgrade note**: a record written before revisions existed is unversioned, so its first write is unconditional, and an old-version writer can still overwrite unconditionally; upgrade every writer before relying on the extension. A recorded `component.reviewed` approve whose state write lost the race was not applied.
- Python port (`kohaku-ui` on PyPI): the same, with `UNSET` meaning "no expectation" and keyword-only `expected_revision` parameters on the `StoragePort` Protocol methods (a custom Python port with the old signatures now fails type checking; at runtime it keeps working).
