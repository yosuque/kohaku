---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/storage-memory": patch
"@kohaku-ui/storage-redis": patch
"@kohaku-ui/storage-postgres": patch
"@kohaku-ui/lineage": patch
---

Storage compare-and-set hardening (follow-up to design.md #79).

- **Unversioned records are guarded** (the `""` state of `expectedRevision`, see the compare-and-set note): all CAS adapters read an absent or non-string `revision` as `""`, and `lineage` passes `""` for such a promotion state or fixation, so a legacy record is no longer overwritten unconditionally by the first write.
- **`persistMany` no longer drops audits on a mid-batch storage error.** It returns `{ persisted, error? }`; `nominateEligible` audits what was stored before the error (`component.nominated`) and only then rethrows it, in the compare-and-set loop, the batch call and the legacy per-item fallback. After a failed write the state is read back, so a write that landed before the error (a timeout after commit) is audited too.
- **storage-redis: per-command errors in an `EXEC` reply are no longer ignored.** A shared `execOrThrow` throws the first one (for example a WRONGTYPE `ZADD` after the `SET` already applied) as a possibly partially applied transaction, at the compare-and-set path and at `appendLineage`, `deleteFixation`, and both plain indexed writes. It is never mapped to `StorageConflictError`; only a null reply stays the conflict signal.
- Python port (`kohaku-ui` on PyPI): the same `persist_many` result and read-back; the lineage paging caveat (allocation order is not visibility order, bound a pack with `until`) is now documented on the Python `StoragePort` too.
