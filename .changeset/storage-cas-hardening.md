---
"@kohaku-ui/spec-core": patch
"@kohaku-ui/storage-memory": patch
"@kohaku-ui/storage-redis": patch
"@kohaku-ui/storage-postgres": patch
"@kohaku-ui/lineage": patch
---

Storage compare-and-set hardening (follow-up to design.md #79).

- **A record with no `revision` is now guarded too.** `expectedRevision` gains a fourth state: `""` means "the record exists but carries no revision" (it predates the field). Every CAS adapter (memory, file, redis, postgres; the Python ports too) compares `(stored.revision ?? "") === expected` and conflicts on an absent record, with no key or DDL change. `lineage` passes `""` for an unversioned promotion state or fixation (candidate store, `unfixate` / `invalidate` / `refreshFingerprint` / `replace`), so two instances that both read a legacy record can no longer overwrite each other's committed decision with their first write. A writer still on an older version writes unconditionally, so upgrade every writer before relying on the 409.
- **`persistMany` no longer drops audits on a mid-batch storage error.** It returns `{ persisted, error? }`; `nominateEligible` audits what was stored before the error (`component.nominated`) and only then rethrows it, in both the compare-and-set loop and the legacy per-item fallback.
- **storage-redis: per-command errors in an `EXEC` reply are no longer ignored.** A shared `execOrThrow` throws the first one (for example a WRONGTYPE `ZADD` after the `SET` already applied) as a possibly partially applied transaction, at the compare-and-set path and at `appendLineage`, `deleteFixation`, and both plain indexed writes. It is never mapped to `StorageConflictError`; only a null reply stays the conflict signal.
- Python port (`kohaku-ui` on PyPI): the same `""` state and `persist_many` result; the lineage paging caveat (allocation order is not visibility order, bound a pack with `until`) is now documented on the Python `StoragePort` too.
