<img src="docs/assets/kohaku-icon.png" alt="kohaku" width="112">

# kohaku — LLM-generated UI, under control

English | [日本語](README.ja.md)

[![CI](https://github.com/yosuque/kohaku/actions/workflows/ci.yml/badge.svg)](https://github.com/yosuque/kohaku/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

kohaku is the governance layer that takes Generative UI to production: the same request on the same data version always gets the same screen, no row of your data ever enters the model's context, every screen is on an audit trail, and whatever the model invents has to pass review before it becomes a part of your product.

- **Identical display is structural, not statistical** — chat and GUI requests normalize to one Intent and one cached UI Spec per data version.
- **The model builds the plumbing; the water never flows through it** — a Spec carries `query://` references, never data values.
- **Freedom is allowed, then governed** — free-form output runs in a sandbox; what is worth keeping is reviewed and promoted to an official part.

Try it on your own CSV / JSON / SQLite file:
```bash
npx @kohaku-ui/cli init --from data.csv --out my-dashboard
cd my-dashboard && npm run dev
```

No data at hand? Use the bundled sample: `curl -O https://raw.githubusercontent.com/yosuque/kohaku/main/cli/test/init/fixtures/sales.csv`, then pass `--from sales.csv`.

**Choose your path:** [MCP Apps only](docs/paths/mcp-apps.md) · [React dashboard only](docs/paths/react-dashboard.md) · [full stack](docs/paths/full-stack.md) — or read [Why kohaku](docs/why-kohaku.md) first.

Under the hood, UI is data (a declarative **UI Spec**) rather than code, and generation (Composition) is fully separated from rendering (Rendering):

```
Natural language (chat) ─┐                                   ┌─ Web (renderer-react)
GUI operations (Web)     ─┼→ canonical Intent → Composition ──┼─ external chat (MCP Apps / same bundle)
                          │   L0 fixed ⇄ L1 declarative ⇄ L2 free-form (+ promotion pipeline)
                          └── data passed by query:// reference ── the LLM builds the plumbing; the water (numbers) never flows through it
```

> **Note on the demo domain**: the bundled sample is a sales-analysis demo that runs in **English by default**. Its natural-language examples are bilingual — both English and Japanese questions normalize to the same Intents — and the demo UI carries an **EN/JA toggle** (selecting JA injects Japanese renderer messages via the i18n override; sample-wc takes `?lang=ja`). The LLM prompts are written in English, and the language of the generated user-visible text is selectable via `ComposePolicy.outputLanguage` (default English). The library itself (APIs, error messages, default UI strings) is English.

## Documentation

| Document | Contents | Audience |
|---|---|---|
| [docs/why-kohaku.md](docs/why-kohaku.md) | **Why kohaku** — the three guarantees (identical display / pass-by-reference / promotion pipeline) and where kohaku sits next to prompt-to-UI tools and agent-UI protocols | Deciding whether it fits |
| [docs/paths/](docs/paths/mcp-apps.md) | **Three one-page starts** — (a) [MCP Apps only](docs/paths/mcp-apps.md), (b) [React dashboard only](docs/paths/react-dashboard.md), (c) [full stack](docs/paths/full-stack.md); each with its first code in 30 lines | Pick the one that matches you |
| [docs/glossary.md](docs/glossary.md) | **Glossary** — a plain-language definition of every kohaku-specific term the docs use, each linked to where it's defined normatively | Look up a term while reading |
| [docs/user-guide.md](docs/user-guide.md) | **User guide** — setup, a tour of the screens, 8 demo walkthroughs, embedding into your product, operations, FAQ | Try it first / embed it |
| [docs/design.md](docs/design.md) | **Implementation design** — architecture, composition pipeline, sandbox, promotion, design decision record | Developers extending / maintaining it |
| [docs/specification.md](docs/specification.md) | **Specification** — reference for UI Spec / REST API / Ports / component catalog / bridge protocol / environment variables | Developers writing against the implementation |
| [spec/SPEC.md](spec/SPEC.md) | **Kohaku Protocol v0.1** (normative) — MUST/SHOULD and conformance requirements | Building a compatible implementation |
| [python/README.md](python/README.md) | **Python implementation guide** — a wire-compatible full port of the TS implementation (conformance CONFORMANT). Setup, layout, cross-language compatibility guards, known differences | Reading / using the Python implementation |
| [AGENTS.md](AGENTS.md) | Development guide for AI coding agents (commands, conventions, pitfalls). `CLAUDE.md` is a pointer that imports it | AI coding agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up, verify, and submit changes (also [日本語](CONTRIBUTING.ja.md)) | Contributors |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability, and what is in scope (the `apps/sample-*` demos are not) | Security researchers |

The same documents are published as a site generated from `docs/` (`pnpm docs:build`; source under `apps/docs-site`, which holds no content of its own).

## Install

The reference implementation is published to npm as `@kohaku-ui/*` (all packages share one version) and to
PyPI as `kohaku-ui` (the distribution name; it still imports as `kohaku`).

```bash
# a REST host (the one-call facade: in-memory storage, HMAC capabilities and an LLM-backed SemanticPort by default) + the React renderer
npm install @kohaku-ui/host @kohaku-ui/renderer-react @kohaku-ui/spec-core zod
# or wire every Port yourself on the bare REST profile instead of the facade
# npm install @kohaku-ui/host-rest @kohaku-ui/renderer-react @kohaku-ui/composer @kohaku-ui/spec-core zod

# check any implementation against the protocol, without installing anything permanently
npx @kohaku-ui/cli conformance --rest http://localhost:8787/api/kohaku

# the Python implementation
pip install "kohaku-ui[rest]"
```

Working on kohaku itself rather than building on it? Start from the quick start below and
[CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start (5 minutes)

**Try it on your own data first?**

```bash
npx @kohaku-ui/cli init --from data.csv --out my-dashboard   # or a .json array / a .sqlite file
cd my-dashboard && npm run dev
```

Generates a runnable Dashboard + Chat app (DomainPort, Intent catalog, L0 fixed Spec) from your own CSV/JSON/SQLite, plus a `.env` with a freshly generated capability secret (add only a provider key to it — never copy `.env.example` over it) — see the [Zero-Port quickstart](docs/user-guide.md#zero-port-quickstart-from-your-own-data-no-port-code) for what it produces and how to add L1/L2. No data at hand? See the bundled sample CSV at the top of this page ([`cli/test/init/fixtures/sales.csv`](cli/test/init/fixtures/sales.csv)). The rest of this section is the monorepo's own dev setup.

Prerequisites: Node >= 22 (>= 22.13 for SQLite input), pnpm 12. CI verifies on Node 22 and 24.

```bash
cp .env.example .env    # LLM provider settings (table below)
pnpm install
pnpm seed               # (optional) only to regenerate the sales seed (output is committed and deterministic, 576 rows; dev works without it)
pnpm dev                # API (:8787) + Web (:5173) together
```

→ http://localhost:5173 — see the [user guide](docs/user-guide.md) for detailed steps and demos.

| LLM | .env settings | Notes |
|---|---|---|
| Claude (default) | `KOHAKU_LLM_PROVIDER=claude` + `ANTHROPIC_API_KEY` | |
| OpenAI | `KOHAKU_LLM_PROVIDER=openai` + `OPENAI_API_KEY` | |
| Gemini | `KOHAKU_LLM_PROVIDER=gemini` + `GOOGLE_GENERATIVE_AI_API_KEY` | |
| Ollama (no key) | `KOHAKU_LLM_PROVIDER=ollama` + `KOHAKU_LLM_MODEL=gemma4:e4b` etc. | non-reasoning models recommended (default when unset is `llama3.3`) |
| llama.cpp etc. | `KOHAKU_LLM_PROVIDER=llama` + `KOHAKU_LLM_BASE_URL` + `KOHAKU_LLM_MODEL` | OpenAI-compatible |

Install the provider SDK next to `@kohaku-ui/llm`: Claude → `@ai-sdk/anthropic`, OpenAI → `@ai-sdk/openai`, Gemini → `@ai-sdk/google`, Ollama / llama.cpp → `@ai-sdk/openai-compatible` (optional peer dependencies; nothing is installed for providers you do not use).

Even without an LLM, the four standard Dashboard views (L0 fixed Specs) are fully functional.

## What you can experience ([detailed steps](docs/user-guide.md#4-demo-walkthroughs-8))

1. **R5 identical display** — a chat question and a GUI operation converge on the same intentHash, giving `cache:HIT` and pixel parity
2. **Pass-by-reference** — zero numbers in the Spec JSON. Data flows component → API directly with a capability token (401 without it)
3. **L2→L1 promotion** — "as a calendar heatmap" → sandboxed free-form generation → review & approval → rendered as an official L1 component from then on (persists across restarts)
4. **Interaction loop and fixation** — row-click drilldown / fixing frequent L1 views to L0 (`cache:FIXATED`, no LLM involved)

## Monorepo layout

| Path | Contents |
|---|---|
| `spec/` | Kohaku Protocol spec + machine-readable requirements + conformance suite |
| `packages/spec-core` | UI Spec schema, Intent canonicalization, diff/patch, cacheKey, **Port types** (the framework boundary) |
| `packages/registry` | Component catalog (15 core parts + runtime-only `ui.loading`), federated resolution, capability negotiation, LLM generation-schema conversion |
| `packages/data-binding` | `query://` reference resolution, capability tokens, STALE detection |
| `packages/storage-memory` | Reference StoragePort implementations: `createMemoryStoragePort()` (pure in-process) and `createFileStoragePort(dataDir)` (file-backed lineage / promotions / fixations) |
| `packages/authz-hmac` | Reference AuthzPort implementation: `createHmacAuthzPort(secret)`, an HMAC-SHA256 capability token |
| `packages/port-contracts` | **Private, test-only.** Shared StoragePort / AuthzPort contract suites every adapter must pass |
| `packages/intents` | Intent DSL (`defineVocabulary` / `defineIntent`) — derives SemanticPort definitions, GUI facets, and MCP tool inputs from a single source of value sets and labels (an environment-neutral leaf depending only on spec-core + data-binding) |
| `packages/llm` | LLM provider abstraction (5 switchable providers, automatic structured-output fallback) |
| `packages/semantic-llm` | Default SemanticPort (`createLlmSemanticPort`): maps GUI/NL input onto an Intent catalog defined with `@kohaku-ui/intents`, via structured output. A starting point — `cli`'s `kohaku init` generates a project on it; sample-api also builds on it |
| `packages/composer` | UI Composition Service (L0/L1/L2, repair loop, deterministic post-processing, Spec cache) |
| `packages/renderer-core` | Shared renderer core (framework-free / DOM-free environment-neutral logic: `resolveEmit`, presenters). Consumed identically by renderer-react and renderer-wc |
| `packages/renderer-react` | Spec→React rendering engine + core component implementations (`./core`) |
| `packages/renderer-wc` | Non-React reference renderer (`<kohaku-surface>` with Custom Elements v1 + Shadow DOM; shared core is renderer-core) |
| `packages/sandbox` | Isolated L2 execution (3-layer defense: opaque iframe / CSP / bridge allowlist) |
| `packages/lineage` | View/Component Lineage, promotion state machine (L2→L1), fixation (L1→L0) |
| `packages/evals` | Golden Spec regression, LLM-as-Judge, FixtureLlm |
| `packages/host-core` | Framework-free shared host core (fixation delivery + self-healing, capability issuance, error-hook helpers). Consumed identically by host-rest and host-mcp-apps, the same relationship renderer-core has with renderer-react / renderer-wc |
| `packages/host-rest` / `host-mcp-apps` | REST / MCP Apps (SEP-1865) profiles |
| `packages/host` | The one-call facade: `createKohakuHost()` wires the default Ports (in-memory storage, HMAC capabilities, the LLM-backed SemanticPort) into host-rest; MCP is the separate `@kohaku-ui/host/mcp` subpath |
| `packages/mcp-renderer` | The shared MCP Apps renderer bundle: `loadRendererHtml()` returns the pre-built, dependency-free single-file HTML; `./boot` rebuilds it with a product's own component implementations |
| `packages/otel` | Thin, opt-in OpenTelemetry layer (`createOtelComposeObserver`, combined via composer's `composeObservers`). Depends only on composer (peer: `@opentelemetry/api`); ships no exporter/SDK setup |
| `packages/host-a2ui` | A2UI-compatible profile skeleton (UISpec/SpecPatch → A2UI messages; an independent leaf on spec-core only) [Draft] |
| `packages/client` | Typed host client SDK (depends only on spec-core + data-binding; independent of host-rest) |
| `packages/admin-react` | Governance console (Lineage / Analytics / Promotion review / Fixation) as embeddable React components on top of `client` (the sample's Admin page is a thin wrapper) |
| `packages/storage-redis` | Redis-backed StoragePort reference adapter (Spec cache, lineage, promotion state, fixation, tenant scoping); `ioredis` is a peer dependency |
| `packages/storage-postgres` | PostgreSQL-backed StoragePort reference adapter (same coverage as storage-redis, idempotent schema); `pg` is a peer dependency |
| `packages/authz-jwt` | JWT / OIDC AuthzPort reference adapter (principal / roles / tenant from claims, shared secret or JWKS); delegates capability tokens to `authz-hmac`, depends on `jose` |
| `apps/sample-api` | Sample: sales-analysis API (**a model implementation of the 4 Ports**) |
| `apps/sample-web` | Sample: Dashboard (GUI) / Chat (NLUI) / Admin (governance) |
| `apps/sample-wc` | Sample: rendering the same Spec with the React-free `<kohaku-surface>` (proof of renderer independence) |
| `apps/sample-mcp` | Sample: MCP server for external chat + the shared renderer |
| `apps/sample-parts` | Sample: the sales-domain product-specific component definitions (`defineComponent`), the single source shared by sample-api, sample-web and sample-mcp |
| `apps/playground` | Sample: a static, server-free build of sample-web that runs the sample-api host inside the browser tab and replays recorded LLM responses |
| `cli/` | `kohaku conformance / scaffold / init / explain / evidence / migrate / dataset / component validate` |
| `python/` | **Python reference implementation** — a wire-compatible full port of the TS `packages/*` (spec / registry / composer / lineage / host-rest / host-mcp) + the sales-api sample. Conformance CONFORMANT. Details in [python/README.md](python/README.md) |

## Development

```bash
pnpm test        # all tests (no LLM required)
pnpm typecheck   # type-check all packages
node cli/bin/kohaku.js conformance --self                                   # spec self-check
node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku # REST black-box check
```

To use the CLI straight from a repository checkout (`node cli/bin/kohaku.js …`), run `pnpm install` first; outside the repository, use `npx @kohaku-ui/cli` instead.

Onboarding pitfalls worth knowing up front:

- Every workspace directory needs a `vitest.config.ts` (its `name` is what `--project` selects) — one without it makes the root config recurse into itself and fail, so even a package with no tests yet needs a minimal `passWithNoTests: true` config.
- Always run tests from the repository root — with `cwd` inside a package, only that package runs. To run a single package, use `pnpm vitest run --project <name>` (names come from each `vitest.config.ts`'s `name`).
- Never write a test that calls a real LLM. Use `FakeLlm` (`@kohaku-ui/llm/fake`, scripted responses) or `FixtureLlm` (`@kohaku-ui/evals`, record/replay) instead.

Development conventions and pitfalls: [AGENTS.md](AGENTS.md). Out-of-scope items for v0.1: [docs/design.md §14](docs/design.md#14-known-limitations-and-v02-candidates).

---

Copyright 2026 yosuque. Licensed under the [Apache License, Version 2.0](LICENSE).
