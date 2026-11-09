# 0021. CI verifies one runtime version per language, and that version is the declared floor

- Status: accepted
- Date: 2026-11-10
- Deciders: yosuque + Claude Code
- Phase: operations

## Context and problem

CI ran Node 24 and 26 and Python 3.12 and 3.13. The declared minimums were `engines.node >=24.22.1` (every published package, the root manifest and the `kohaku init` project) and `requires-python >=3.12`. These floors were set in ec723342 on the principle that the declared floor must be a version CI actually runs.

The maintainer wanted fewer CI variants. Dropping the lower leg while keeping the old floors would have broken that principle, and nothing else would cover the gap:

- `@types/node` is `^26` in the catalog, so `tsc` does not flag an API that exists only on Node 26. Only the Node 24 test run did.
- For Python, ruff (`target-version`) and mypy (`python_version`) already checked the 3.12 floor statically. Only runtime behaviour was left to the 3.12 run.

The history showed little direct value from the extra legs. In the 150 CI runs since 2026-10-17 (9 failures), no failure was specific to one version. On the other hand, the legs never sat on the critical path either: `ci (24)` took 158 s while `ci (26)` took 277 s.

## Options considered

- **A. Keep both versions per language.** Nothing is lost, but the check list stays long.
- **B. Run the floor versions only on pushes to `main` and nightly, not on pull requests.** Coverage stays, but a floor break is found after merge, and `ci-ok` would have to accept skipped jobs.
- **C. Raise each floor to the version CI keeps, and verify only that one version.** Breaking for consumers on the older runtime.
- **D. Single Python version only, with the floor held by static checks.** Smaller blast radius, but it leaves Node unchanged.

Within C, for Node: float the major (`node-version: 26`, latest 26.x, floor `>=26.0.0` untested), or pin CI to one exact version and declare `>=` that version.

## Decision

Chosen: **C, with Node pinned to an exact version** (PR #138).

- **Policy.** CI runs exactly one Node version and one Python version. The declared floor (`engines.node`, `requires-python`) is that version. Older and newer releases are not tested. Floors are raised deliberately, reviewed at least when a new Node LTS line or Python minor version ships, and each raise is a breaking change recorded in a changeset (`minor` while 0.x). Written in CONTRIBUTING.md §2.
- **Node: `.node-version` is the single source, now 26.12.1.**
  - Every workflow's setup-node uses `node-version-file: .node-version`.
  - `scripts/lib/node-floor.mjs` derives `>=26.12.1` from it. `pnpm meta:sync` writes that into all 30 published packages and the root `package.json`. `pnpm init:versions` emits it as `NODE_ENGINES` for the `kohaku init` project.
  - Tests and CI drift checks fail when any of these differ from `.node-version`.
- **Python: 3.13.** `requires-python >=3.13` in the three pyproject files, classifiers, ruff `py313`, mypy `3.13`. CI uses `PYTHON_VERSION: "3.13"` in ci.yml, and the same version in release.yml and published-e2e.yml. There is no single source file, so CONTRIBUTING.md lists every place to change.

### Rationale

- It keeps the ec723342 principle, so nothing is promised that CI did not run, while cutting the variants the maintainer wanted gone.
- Pinning makes "the version CI verifies" and "the declared floor" literally the same value. Raising the floor becomes: edit `.node-version`, run `pnpm regen`, regenerate the init goldens, update the docs, add a changeset.
- B delays the signal past merge and complicates the gate. D addresses only the cheaper half.
- Node 26 had been Active LTS since October 2026. Python 3.13 is supported upstream well beyond this release line.

## Consequences (trade-offs)

- **Good:**
  - One version per runtime, with the floor generated from one file for Node.
  - CI's check list went from 10 to 8 per pull request, on top of [ADR-0020](0020-ci-ok-is-the-single-required-ci-check.md).
  - What the packages claim is exactly what CI verified.
- **Costs / bad:**
  - Consumers on Node 24 (supported upstream until 2028-04) or Python 3.12 must upgrade before taking the release.
  - Newer runtimes are untested: later Node 26 patches until `.node-version` is bumped, Node 27+, and Python 3.14+. uv.lock resolves a separate dependency set for 3.14, and CI never exercises it.
  - The Python floor still has to be changed in several files by hand.
- **Revisit when:** a new Node LTS line or Python minor version ships; a consumer needs an older runtime; or a bug appears that only a newer runtime than the floor reproduces. In that last case, add a second, non-blocking leg rather than abandoning the policy.

## References

- PR #138 (this decision), commit ec723342 (the "floor follows what CI verifies" precedent)
- [ADR-0020](0020-ci-ok-is-the-single-required-ci-check.md), [ADR-0011](0011-python-keeps-full-parity-with-typescript.md), [ADR-0012](0012-init-version-table-is-generated-from-the-pnpm-catalog.md)
- CONTRIBUTING.md §2 "Supported runtime versions"
