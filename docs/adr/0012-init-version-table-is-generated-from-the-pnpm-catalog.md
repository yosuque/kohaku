# 0012. The `kohaku init` version table is generated from the pnpm catalog

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

`cli/src/init/versions.ts` is the table of external dependency versions that `kohaku init` writes into generated projects. It was a hand-maintained mirror of the `catalog:` block in `pnpm-workspace.yaml`, guarded by a test in `cli/test/init/render.test.ts`. Dependabot can bump the catalog but cannot edit `versions.ts`, so every catalog bump turned that test red until someone synced the file by hand. The 2026-11-08 analysis (proposal E5) counted this as 8 of the 9 CI failures among the last 50 runs, and called it structural. CONTRIBUTING §5 also listed only 5 of the 17 generated artifacts that CI enforces.

## Options considered

- **Option A**: generate `versions.ts` from the catalog and fail CI on drift.
- **Option B**: keep the hand-written table guarded by a test (the status quo).

The wp-e5 report suggested adding a line to [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.md) instead of writing a new ADR, because the change follows from that dependency policy; the maintainer approved recording it as its own ADR.

## Decision

Chosen: **Option A**

- `scripts/sync-init-versions.ts` (`pnpm init:versions`) writes `cli/src/init/versions.ts` from the catalog. The file carries a `GENERATED` header and is never edited by hand.
- `scripts/lib/read-catalog.mjs` is a strict parser for the `catalog:` block, shared by the generator, `render.test.ts` and `scripts/pack-smoke.mjs`. A non-blank, non-comment line it cannot parse throws with its line number. It accepts trailing comments, quoted keys and values, and CRLF; it rejects unquoted values with spaces, nested mappings and multi-line values. pack-smoke now fails on a missing catalog key instead of falling back to `"*"`.
- CI runs the generator and `git diff --exit-code -- cli/src/init/versions.ts`. `render.test.ts` checks the values and the key set in both directions and byte-compares the committed file with the generator output.
- `pnpm regen` regenerates every generated artifact in dependency order and stops at the first failure. CONTRIBUTING §5 (EN and JA) lists every generated artifact CI enforces, plus the two hand-pinned ones.

### Rationale

- The catalog becomes the single source of the versions. A catalog bump is followed by one command, `pnpm init:versions` (or `pnpm regen`), instead of a hand edit that no bot could make.
- A strict parser turns a catalog line it does not understand into an error with a line number, rather than a silently wrong version in generated projects.

## Consequences (trade-offs)

- Good: the table cannot silently disagree with the catalog, and the hand-editing step is gone. The values were unchanged by the switch. Bumping a catalog entry turns the test red and `pnpm init:versions` turns it green again; hand-editing `versions.ts` fails the drift step.
- Costs / bad: Dependabot still cannot regenerate the file, so a Dependabot PR that bumps the catalog stays red until someone runs `pnpm init:versions` and pushes (the `dependabot.yml` comment says so). The parser supports only the catalog forms listed above.
- Revisit when: the catalog needs a form the strict parser rejects.

## References

- PR: #112
- Proposal E5 in `research_notes/pm-analysis-2026-11-08/improvement-proposals.md` (git-excluded, kept in the maintainer's checkout)
- [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.md): the dependency update policy this builds on
