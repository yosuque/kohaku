# 0005. Compare-and-set is an optional StoragePort extension

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: design

## Context and problem

When several host instances share one redis or postgres backend, two of them could silently lose a promotion state or a fixation update: the in-process keyed mutex only orders calls inside one process, and SPEC Appendix 12 declared compare-and-swap out of scope. The maintainer decided that a lost write should surface as `409 CONFLICT` and that the host should not retry on its own. The remaining questions were how to make that part of the `StoragePort` contract without breaking existing adapters, and how each backend can implement it correctly.

## Options considered

- **Option A**: an optional, declared extension. A port sets `supportsCompareAndSet: true` and honors a tri-state `expectedRevision` (omitted = unconditional, `null` = must not exist, string = must equal) on `putPromotionState`, `putFixation` and `deleteFixation`; a mismatch throws `StorageConflictError` without writing.
- **Option B**: a mandatory compare-and-set contract for every `StoragePort`.
- **Option C**: host-level distributed locks.

The wp-e8b report records Option A as chosen "instead of a mandatory CAS contract or host-level distributed locks"; it does not record further reasons for rejecting B and C beyond what the Rationale below says.

Sub-decisions that also had a rejected alternative:

- **File port**: declare the extension (rejected in review) or not.
- **Bulk nomination**: a per-item expectation on the batch `putPromotionStates` (rejected) or a conditional write per candidate.
- **Redis, TypeScript**: serialize every `MULTI` on the shared connection (rejected) or run `WATCH` on a dedicated connection.

## Decision

Chosen: **Option A**

- **Contract**: `StoragePort.supportsCompareAndSet`, `PromotionState.revision?` (joining the existing `FixationRecord.revision?`), the tri-state `expectedRevision`, and the spec-core `StorageConflictError` (`code: "STORAGE_CONFLICT"`). The batch `putPromotionStates` gets no expectation.
- **Hosts**: `StorageConflictError` becomes `409 CONFLICT` with the fixed message `the resource was modified concurrently; reload and retry`, which never carries the storage error's own text. Hosts do not retry. MCP reports the same fixed message as a tool error. REST reports each conflict to `onError` as `storage.conflict`. The SPEC states this as REST-CONF-001 (SHOULD [Draft], verified by the reference implementation's tests).
- **Memory port**: declares the extension and `singleProcess: true`.
- **File port**: honors `expectedRevision` (against the snapshot re-read from disk inside its in-process lock) but does not declare `supportsCompareAndSet`, because a lock that only orders calls within one process is not atomic across processes, and `sample-api` plus `sample-mcp` sharing one `.data` is a documented setup. It carries `singleProcess: true` instead. `createKohakuHost` warns once about a custom port that declares neither.
- **Redis (TS)**: `WATCH` / `GET` / `MULTI` / `EXEC` (no Lua) on a dedicated, lazily opened connection with `enableOfflineQueue: false` and `autoResendUnfulfilledCommands: false`, serialized by a mutex. A `ready`-event epoch is checked just before `EXEC`, so a reconnect that silently dropped the server-side `WATCH` becomes a conflict.
- **Redis (Python, PR #129)**: `Pipeline.watch`, which pins a pooled connection for the whole transaction, so no process-wide mutex or epoch is needed. Only a null `EXEC` (redis-py's "Watched variable changed") is a conflict. A communication error while watching is re-raised, because it may have struck after `EXEC` applied the write, and reporting it as "conflict, nothing modified" would be wrong.
- **Postgres**: no DDL. One conditional `UPDATE ... WHERE (payload::jsonb ->> 'revision') = $n` / `INSERT ... ON CONFLICT DO NOTHING` / `DELETE`, with `rowCount` deciding. SQLSTATE `40001` maps to the same conflict.
- **Promotion**: `nominateEligible` writes each candidate with `putPromotionState` conditional on the revision its scan loaded (`null` when no state existed) and skips a candidate that lost the race, recording no `component.nominated` for it. `act()` re-reads the stored revision right before recording its audit event; "audit first, state second" is kept.
- **Fixation**: `unfixate`, `replace`, `invalidate` and `refreshFingerprint` pass the revision they read. The two self-heal calls (`invalidate`, `refreshFingerprint`) treat a lost race as a no-op, since another instance already healed the fixation. `unfixate` and `replace` are human decisions and surface the conflict. `fixate` stays an unconditional human overwrite.

### Rationale

- An optional, declared extension keeps every existing adapter and fake port valid (they ignore the option) while letting the shared-backend adapters close the gap.
- The host does not retry because a conflict means a person or another instance decided something in between, and re-applying the same transition blindly could publish over a withdrawal.
- Bulk nomination cannot use the batch write: an unconditional batch would roll back an approve that another instance recorded after the scan. A per-candidate conditional write was chosen over a per-item expectation on `putPromotionStates`, which would complicate every adapter's batch path for a cheap, repeatable pass.
- On a shared pipelined redis connection, `WATCH` state belongs to the connection and an `EXEC` from any other `MULTI` would clear it, hence the dedicated connection.
- The file port does not declare the extension because declaring it would claim an atomicity it does not have.

## Consequences (trade-offs)

- Good: concurrent writers on a shared redis or postgres now get exactly one success and one 409 (tested with two apps on one CAS store, in TS and Python). Existing adapters keep working unchanged. The in-process mutexes stay and still serialize within one process.
- Costs / bad:
  - **Orphan event, accepted and documented, not fixed.** The `act()` re-read narrows the window but cannot close it. A `component.reviewed` event can be recorded for an approve whose conditional persist then lost the race and was not applied (the caller got a 409). Reconcile ignores it because it reads snapshots only. Evidence-pack and analytics readers must treat the snapshot, not the event, as the authority.
  - Rolling upgrade: a record that predates `revision` (or is unreadable) is written unconditionally once, which stamps one. A writer still on the old version overwrites unconditionally, so every writer must be upgraded before the extension is relied on.
  - Sharing one `.data` directory between processes on the file port can still lose updates.
  - A custom Python port with the old `StoragePort` signatures fails type checking after the keyword-only `expected_revision` parameters were added, but keeps working at runtime because the lineage services pass the keyword only to a port that declares `supports_compare_and_set`.
  - Python's redis adapter deliberately diverges from the TS design (no dedicated connection, mutex or epoch); each conditional write holds one pooled connection.
- Revisit when: a compensating event for the orphan `component.reviewed` is wanted (recorded as an ADR candidate in wp-e8b).

## References

- PRs: #127 (the extension, TS and Python), #129 (the Python redis / postgres adapters)
- design.md decision #79; SPEC Appendix 12 and REST-CONF-001
