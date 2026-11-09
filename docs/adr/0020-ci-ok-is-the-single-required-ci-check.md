# 0020. `ci-ok` is the single required CI status check

- Status: accepted
- Date: 2026-11-09
- Deciders: yosuque + Claude Code
- Phase: operations

## Context and problem

The `main` ruleset named every CI job and matrix leg as a required status check: 10 contexts, later 12. When f43a74cd turned `conformance-python` into a `file` / `redis` / `postgres` matrix, the bare `conformance-python` context never reported again. The ruleset kept waiting for it, and the release pull request (#105) sat at "Expected — Waiting for status" even though all 18 of its checks were green. `gh pr checks --required` lists only contexts that reported, so it did not show the missing one. Every other pull request in between was merged with `--admin`, which bypasses the ruleset and so hid the problem.

At the same time, a pull request showed 19 checks. Most CI jobs spent 20–50 s on runner and service-container setup around a few seconds of work. The six conformance legs each ran a check of about 3 s.

## Options considered

- **A. Keep naming each job, and update the ruleset whenever the job layout changes.** This is a manual step that nothing enforces. Forgetting it is exactly how #105 stalled.
- **B. Consolidate the jobs, but keep requiring them by name.** Fewer names to keep in sync, but the same failure mode stays.
- **C. Consolidate the jobs, and add one `always()` gate job that `needs` every job. Require only that gate, plus CodeQL's two `analyze` legs (a separate workflow).**

## Decision

Chosen: **C** (PR #137, ruleset `main` updated on 2026-11-09).

- `ci.yml` has four work jobs (`ci`, `python`, `integration`, `build`) and the gate `ci-ok`.
  - `integration` absorbs the former `adapters` job and the six conformance legs. It runs one step per (host, storage) pair against one Redis and one Postgres service. `scripts/ci-conformance.sh` gives each pair its own Redis key prefix and Postgres schema.
  - `build` absorbs `pack-smoke`, `docs-site` and the report-only `changeset-check`.
  - `playground-drift` was removed from ci.yml because no fixture has been recorded, so it checked nothing. `pages.yml` still runs it, blocking, before a deploy.
- `ci-ok` runs with `if: always()` and fails unless every result in `needs` is `success`. A failed or cancelled dependency therefore produces a failing `ci-ok`, not a skipped one, which a ruleset would treat as missing.
- The ruleset requires `ci-ok`, `analyze (javascript-typescript)` and `analyze (python)`, with the strict up-to-date policy unchanged.

### Rationale

- The ruleset no longer depends on the job layout. Jobs can be renamed, split, merged or matrixed without touching repository settings. Only adding a job to `ci-ok`'s `needs` changes what blocks a merge.
- Consolidating removed per-job setup without lengthening the run: the critical path is still `ci` (about 4.5 min), and `integration` / `build` finish within it.
- The repository is public, so runner minutes cost nothing. The gains are a readable check list and one place to maintain what is required.

## Consequences (trade-offs)

- **Good:**
  - Checks per pull request went from 19 to 10, and from 10 to 8 after [ADR-0021](0021-ci-verifies-one-runtime-version-which-is-the-declared-floor.md).
  - Required contexts went from 12 to 3.
  - A stale required context can no longer silently block a merge.
- **Costs / bad:**
  - A failure shows up as `ci-ok` plus the failing job. Inside `integration`, the failing leg is identified by its step name rather than by a check name.
  - The conformance legs and the adapter suites share one Redis / Postgres. Their isolation rests on the per-pair key prefix and schema in `scripts/ci-conformance.sh`.
  - `ci-ok` depends on the whole `ci` job, so every leg of it became blocking, including the former non-required Node 24 leg.
- **Revisit when:** a job must be visible but deliberately non-blocking (keep it out of `needs`), or CodeQL moves into ci.yml (then it can sit behind `ci-ok` too).

## References

- PR #137 (consolidation and the gate), release PR #105 (the stall), commit f43a74cd (the matrix change that orphaned the context)
- [ADR-0021](0021-ci-verifies-one-runtime-version-which-is-the-declared-floor.md)
