# 0011. The Python implementation keeps full parity with TypeScript, and no freeze applies

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

The Python implementation (`python/`) is a wire-compatible full port of the TypeScript one (conformance CONFORMANT). The 2026-11-08 PM and EM analysis proposed freezing it as improvement E9. The proposal read: keep only the current features and wire compatibility, make new features TypeScript-only, publish the gap list in python/README, and add only E4's contract tests to Python. Its grounds were:

- Python is about 67k lines, and 27% of the commits since 2026-10-05 touched `python/`.
- Even so, a production-path defect (#104, see [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.md)) was not prevented.
- PyPI downloads are not evidence of real use.

On 2026-11-08 the maintainer rejected E9 and asked that every mirror gap be closed.

## Options considered

- **Option A**: keep full parity. Every TypeScript change that has a Python counterpart is ported in the same PR, and the existing gaps are closed.
- **Option B**: freeze the Python port (proposal E9), rejected by the maintainer.

## Decision

Chosen: **Option A**

- **Same PR**: a change with a Python counterpart is ported in the same PR, following the `python-mirror` procedure. The TypeScript tests are the source of truth for behaviour; a port copies their cases one to one into Python tests, and the work-package report records the correspondence.
- **Existing gaps closed**: the entries of python/README's "Not yet ported" list and the two differences it recorded as permanent (MCP Tasks, `migrateProps`) were all ported in the 2026-11 run: `migrate_props` (#117), `kohaku.semantic_llm` (#119), MCP Tasks (#120), the promotion-review features (#123), `kohaku.authz_hmac` (#125), `kohaku.authz_jwt` (#126) and the redis / postgres StoragePorts (#129). The other work packages of the run (#115, #121, #122, #124, #127, #128) were each delivered with their Python mirror.
- **Deterministic outputs** (token bytes, storage keys and row shapes, cache-key and fingerprint material, pure-function results) are pinned by cross-language golden fixtures, so both languages must match.
- **Structure**: a new Python subpackage adds a layer to the import-linter contract that follows the TypeScript dependency direction. External libraries are added as extras, with the floor chosen under the [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.md) policy.
- **Exceptions**: only parts with no Python counterpart stay TypeScript-only: `cli`, `docs-site`, GitHub Actions and `admin-react`. `admin-react` is a React UI; since the wire is identical, the TypeScript `admin-react` works against a Python host unchanged.

### Rationale

- The maintainer's decision. The proposal's observation that parity did not prevent #104 is answered by a different measure: the contract tests of PR #115 exercise the real provider SDKs in both languages, which is what #104 lacked, rather than by reducing the Python surface.
- With golden fixtures and one-to-one test ports, a parity break shows up as a failing test instead of as drift found later.

## Consequences (trade-offs)

- Good: python/README's gap list now names only `admin-react`. The Python redis and postgres adapters are data-compatible with TypeScript, so hosts in both languages can share one backend. Deterministic outputs match byte for byte.
- Costs / bad:
  - Every TypeScript change with a Python counterpart carries the porting work in its own PR, on a roughly 67k-line second implementation.
  - The README wording for `admin-react` still reads "Not yet ported"; reclassifying it as TypeScript-only is a remaining task.
- Revisit when: the sources record no condition for revisiting the rejection. The grounds of E9 (maintenance load of the Python port, and PyPI downloads as the only usage signal) are the evidence that would reopen the question.

## References

- Proposal E9 in `research_notes/pm-analysis-2026-11-08/improvement-proposals.md` (git-excluded, kept in the maintainer's checkout) and §11 of the 2026-11 implementation plan
- PRs: #117, #119, #120, #123, #125, #126, #129
- python/README, "Not yet ported" list; AGENTS.md, "Python implementation"
- [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.md), [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.md)
