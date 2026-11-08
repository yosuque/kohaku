# 0001. Record architecture decisions as ADRs

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: operations

## Context and problem

The reasons behind decisions made during requirements, design and implementation are easily lost over time. When development is done together with Claude Code, the reasoning ends up buried in chat history and cannot be traced later. Until now, this repository kept implementation decisions in [design.md](../design.md)'s decision record and in commit messages and PR descriptions, so a cross-cutting operational policy (for example, how dependencies are updated) had no single place to live. We want the context, options and trade-offs of each decision kept in the same repository as the code.

## Options considered

- **Option A**: keep ADRs in `docs/adr/` in MADR format, versioned with Git
- **Option B**: keep them in a wiki or an external document tool
- **Option C**: do not record them (leave them in commit messages and PR descriptions)

## Decision

Chosen: **Option A (MADR-format ADRs in `docs/adr/`)**

### Rationale

- In the same repository as the code, the change history and the decision history can be traced together.
- Plain Markdown is tool-independent and its diffs are easy to read.
- Numbered files are easy to list and to cite (ADR-NNNN).

## Consequences (trade-offs)

- Good: the reasons behind decisions persist, which makes onboarding and later reconsideration easier.
- Costs: writing an ADR for each decision is an operational load (eased by the `/adr` skill). Because `docs/` is mirrored to the documentation site, each ADR needs a sidebar entry and, by the repository's convention, an English canonical file plus a `.ja.md` counterpart.
- Revisit when: the practice becomes a formality; then redefine which granularity of decision is recorded.

## References

- MADR (Markdown Any Decision Records): https://adr.github.io/madr/
- Template: [0000-template.md](0000-template.md)
