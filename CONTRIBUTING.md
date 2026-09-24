# Contributing to kohaku

English | [日本語](CONTRIBUTING.ja.md)

Thank you for your interest in kohaku. This document is the entry point for external contributors. For day-to-day development conventions and pitfalls (the same guide AI coding agents use), see [AGENTS.md](AGENTS.md). Recurring step-by-step procedures live under `docs/runbooks/` (e.g. [protocol-change.md](docs/runbooks/protocol-change.md), [add-component.md](docs/runbooks/add-component.md), [python-mirror.md](docs/runbooks/python-mirror.md)) — this document intentionally stays at the policy level and links out to those rather than duplicating their steps.

## 1. Ways to contribute

- **Bug report** — open an issue using the *Bug report* template.
- **Feature request** — open an issue using the *Feature request* template.
- **Conformance report** — if you maintain another implementation of the Kohaku Protocol (a different language, a different host), report the result of running `kohaku conformance --rest <url>` against it using the *Conformance report* template. This is the intended channel for cross-implementation compatibility discussion; see [spec/SPEC.md](spec/SPEC.md) for the normative protocol this checks against.
- **Pull request** — see [§10](#10-commits-and-pull-requests) below.

All issue templates are under `.github/ISSUE_TEMPLATE/`.

## 2. Prerequisites

- Node >= 22, pnpm 12 (the floor declared in `package.json`'s `engines`). `.node-version` pins 25.7.0 for local development; CI verifies both Node 22 (the declared floor) and Node 24.
- [uv](https://docs.astral.sh/uv/) — only needed if you touch anything under `python/`.

## 3. Setup

```bash
cp .env.example .env    # LLM provider settings; a key is optional
pnpm install
pnpm test
```

An LLM key is not required to get started: the L0 fixed Specs (and everything `pnpm test` exercises) work fully without one. You only need a key to exercise the L1/L2 generation path with a real provider.

## 4. Verification discipline

- After any change, always run `pnpm test && pnpm typecheck && pnpm check:ci` from the **repository root**. The last one is Biome (formatting + lint), which CI also runs; `pnpm check` applies the fixable parts in place. Running from inside a package directory only exercises that package.
- To run a single package's tests: `pnpm vitest run --project <name>` (the name comes from that package's `vitest.config.ts`).
- If you touched anything under `python/`:
  ```bash
  cd python && uv run ruff check && uv run mypy && uv run lint-imports && uv run pytest
  ```
- If you touched the protocol (`spec/`), run a self-check: `node cli/bin/kohaku.js conformance --self`.

## 5. Generated artifacts

Several files in this repository are generated, not hand-written. CI regenerates each one and fails the build on any diff (`git diff --exit-code`), so **a change that requires regeneration must include the regenerated output in the same commit**. Never hand-edit a generated file listed below.

| Command | Output | When it is needed |
|---|---|---|
| `pnpm --filter @kohaku-ui/spec run generate-schemas` | `spec/schemas/` | After changing the Zod schemas in `packages/spec-core/src/schema/*.ts` |
| `pnpm --filter @kohaku-ui/registry run export-core-catalog` | `python/kohaku/src/kohaku/registry/_data/core-catalog.json` | After changing `packages/registry/src/core/*` |
| `pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures` | `spec/test/fixtures/cross-language-canonical.json` | After changing canonical JSON / hash / cacheKey / the sanitize allowlist |
| `pnpm intents:emit` | `apps/sample-web/src/generated/facet-views.json` | After changing facets in `apps/sample-api/src/intents/catalog.ts` |
| `pnpm seed` | `apps/sample-api/src/domain/seed/` | After changing the seed generator |

If more than one applies, run them in this order (install first, since later steps depend on the workspace being installed):

```
pnpm install
pnpm --filter @kohaku-ui/spec run generate-schemas
pnpm --filter @kohaku-ui/registry run export-core-catalog
pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures
pnpm intents:emit
pnpm seed
```

## 6. Bilingual documentation

English (unsuffixed) is the canonical source for every document; the `.ja.md` counterpart must be updated in the same change. This applies to: `README.md`, `docs/design.md`, `docs/specification.md`, `docs/user-guide.md`, `spec/SPEC.md`, `python/README.md`, and `CONTRIBUTING.md` itself.

## 7. Testing rules

- **Never write a test that calls a real LLM.** Use `FakeLlm` (`@kohaku-ui/llm/fake`, scripted responses) or `FixtureLlm` (`@kohaku-ui/evals`, record/replay) instead.
- A test that involves persistence must pass a `mkdtemp` temporary directory rather than touching `apps/sample-api/.data/` (that directory is local runtime state, not test fixture state).
- If you intentionally change rendered UI output, regenerate the golden Specs with `KOHAKU_GOLDEN_UPDATE=1` and review the diff before committing it.
- `storage-redis` and `storage-postgres`'s adapter tests use Docker (via testcontainers) when it's available, pulling `redis:7-alpine` / `postgres:16-alpine` on first run; set `KOHAKU_ADAPTER_TESTS=skip` to skip them entirely (e.g. when Docker isn't installed).

## 8. Dependency direction

The package dependency direction (no reverse flow) is enforced in three places at once:
- `spec/test/dependency-direction.test.ts`'s `LAYERS` array (TS)
- `python/pyproject.toml`'s `[tool.importlinter]` section (Python)
- `AGENTS.md`'s description of the dependency direction (documentation)

If you add a new package, or an import that crosses a layer boundary, update all three.

Every workspace directory needs its own `vitest.config.ts` (its `name` is what `--project` selects) — one without it makes the root Vitest config recurse into itself and fail. A package with no tests yet still needs a minimal `passWithNoTests: true` config.

## 9. Working with AI coding agents

[AGENTS.md](AGENTS.md) is the single source of truth for agent-facing guidance (commands, conventions, pitfalls). `CLAUDE.md` and `.github/copilot-instructions.md` are pointers into it, not duplicates — update `AGENTS.md`, not the pointers.

Recurring change procedures live under `docs/runbooks/`; `.claude/skills/` are thin wrappers around those runbooks, not a separate source of instructions.

The repository ships an `.mcp.json` so you can use the `kohaku-sales` MCP server directly. To see rendered UI (not a placeholder), build the shared renderer first: `pnpm --filter @kohaku-ui-sample/mcp build:renderer`. The `start:http` HTTP entry point is an **unauthenticated demo** — do not expose it through a public tunnel.

## 10. Commits and pull requests

- One commit, one concern.
- Commit messages follow Conventional Commits in English (`feat(scope): ...`, `fix: ...`, `docs: ...`, `ci: ...`, `chore: ...` — check `git log` for the exact style in use).
- Fill out the pull request template's checklist.
- If you changed the L1/L2 prompt (`packages/composer/src/prompt.ts`), bump `PROMPT_REVISION`. This is an operational value that separates the compose cache by prompt generation; the checklist item exists specifically so it doesn't get missed in review.
- **No CLA and no DCO are required.** Per Apache-2.0 §5, contributions you submit are accepted under the same license as the project.

## 11. Releases

Releases run from `main` through Changesets, in two steps. Add a changeset to any pull request that
changes published behaviour:

```bash
pnpm changeset
```

Once a changeset-carrying pull request merges to `main`, the Version workflow opens or updates a
`chore(release): version packages` pull request. Review that pull request's diff before merging it: it
touches all twenty-seven package manifests, the twenty-seven `CHANGELOG.md` files, `python/kohaku/pyproject.toml`,
`python/kohaku/src/kohaku/__init__.py`, and the lockfile. Merging it does **not** publish — it makes a
draft GitHub Release `vX.Y.Z` appear, with a body generated from the CHANGELOGs. Publishing is a
separate, deliberate step: run the Release workflow with `dry_run=true` from `main` first, then publish
the draft (which creates the tag), then watch the Release workflow publish to npm and then PyPI. See
[docs/runbooks/release.md](docs/runbooks/release.md) for the full procedure and the pre-publish
checklist.

All twenty-seven `@kohaku-ui/*` packages share one version — they are one implementation of one wire protocol,
and a version split would let a consumer end up with two incompatible `spec-core` copies. See
[.changeset/README.md](.changeset/README.md). Nothing is published from a developer's machine.

## 12. Dependencies

- Dependency updates arrive through Dependabot PRs.
- CI's `pnpm audit --prod --audit-level=high` is currently report-only (non-blocking).
- `zod` is a peerDependency in every package. Bump its version only in the `catalog:` entry in `pnpm-workspace.yaml` — never per-package.
