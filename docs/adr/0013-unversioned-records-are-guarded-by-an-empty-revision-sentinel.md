# 0013. Unversioned records are guarded by an empty-revision sentinel

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

[ADR-0005](0005-storage-compare-and-set-is-an-optional-extension.md) made compare-and-set an optional `StoragePort` extension. Its `expectedRevision` had three states:
- omitted: unconditional write
- `null`: the record must not exist
- a string: the stored revision must equal it

A `PromotionState` or fixation written before `revision` existed has no revision, so callers loading it passed "omitted" and every write to it was unconditional.

A post-merge Codex (gpt-6-astra) review (finding C3) showed, and an independent verifier reproduced, that this defeats CAS for the whole lifetime of such a record, not just for one write. Two instances that both read an unversioned `in_review` record could each write: a reject and an approve both succeeded, and the stale approve overwrote the committed reject. This happened even when every instance ran the new version. The user guide then framed the risk only as "a writer still on the old version".

## Options considered

- **Option A**: add a fourth `expectedRevision` state, the empty string `""`, meaning "the record exists but carries no revision". Every CAS port compares against it, and callers pass it for an unversioned record they loaded.
- **Option B**: keep three states. Make a one-off backfill mandatory: stamp a revision on every unversioned promotion and fixation record, on a single instance, before starting several instances. Correct the user guide to say so.
- **Option C**: keep the behaviour and only document it.

## Decision

Chosen: **Option A** (the maintainer approved the sentinel approach on 2026-11-08; PR #133).

- **Comparison rule, identical in every CAS port:**
  - When the record exists, it matches if `normalise(stored.revision) === expected`.
  - Normalisation: a revision that is not a string (absent, `null`, number, boolean, object) normalises to `""`.
  - When the record does not exist, `""` is a conflict (or a no-op with `ifPresent`).
- **Ports:**
  - TS: memory, redis, postgres. The TS file port still does not declare CAS (ADR-0005).
  - Python: memory, file, redis, postgres.
  - Postgres compares `CASE WHEN jsonb_typeof(payload::jsonb -> 'revision') = 'string' THEN … ELSE '' END`.
  - Keys and DDL are unchanged, so TS and Python stay data-compatible on one backend.
- **Callers:** these pass `""` for a present record without a revision:
  - the promotion candidate store: act, bulk nomination
  - the fixation service: unfixate, replace, invalidate, refreshFingerprint, self-heal
- **Contract and docs:**
  - Contract cases are added to `@kohaku-ui/port-contracts`' `requireCompareAndSet` and to the Python `_contract.py`, including non-string revisions. The TS ⇄ Python interop suite covers `""` in both directions.
  - Docs updated: SPEC §6.1 and Appendix 12, the specification, design #79 and the user guide (EN and JA).

### Rationale

- **Option A closes the hole for every record, at no operational cost.** An operator does not have to remember a migration step before scaling out.
- **Option B depends on that step being run.** An instance that read a record before its first versioned write would still be unguarded.
- **Option C leaves a silent lost-update path.** That path is exactly what ADR-0005 set out to remove.
- **`""` is the right sentinel.** It never collides with a real revision, because revisions are generated non-empty tokens. It fits the existing string-typed field without a schema change.
- **Non-string normalisation keeps the ports consistent.** Before it, a corrupted row with `revision: 5` behaved differently per port: memory and postgres conflicted forever, while redis and Python file healed. Treating it as unversioned makes every port agree, and the row repairs on its next guarded write.

## Consequences (trade-offs)

- **Good:**
  - A concurrent reject/approve on an unversioned record now gives one success and one 409, the same as on a versioned record.
  - The first write stamps a revision, after which the record is ordinary.
  - No migration and no DDL change.
- **Costs / bad:**
  - `expectedRevision` now has four states, which every custom CAS adapter must implement. The contract suite pins it.
  - A writer still on a version before #127 writes unconditionally, so "upgrade every writer before relying on CAS" remains in the user guide.
- **Revisit when:** a backfill tool exists anyway (for example, for a schema migration). At that point the sentinel could be retired in favour of "every record is versioned".

## References

- PRs: #127 (CAS extension), #129 (Python redis/postgres ports), #133 (this decision)
- [ADR-0005](0005-storage-compare-and-set-is-an-optional-extension.md): the optional CAS extension this amends
- design.md decision #79
