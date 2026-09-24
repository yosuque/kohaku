<img src="docs/assets/kohaku-icon.png" alt="kohaku" width="112">

# kohaku — an AI-native GUI library (reference implementation)

English | [日本語](README.ja.md)

[![CI](https://github.com/yosuque/kohaku/actions/workflows/ci.yml/badge.svg)](https://github.com/yosuque/kohaku/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

A Generative UI foundation that treats UI as data (a declarative **UI Spec**) rather than code, and fully separates generation (Composition) from rendering (Rendering).

**"The same request produces the same display, whether it comes from chat or from the Web"** — guaranteed structurally by unifying the UI Composition Service and caching Specs.

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
| [docs/user-guide.md](docs/user-guide.md) | **User guide** — setup, a tour of the screens, 8 demo walkthroughs, embedding into your product, operations, FAQ | Try it first / embed it |
| [docs/design.md](docs/design.md) | **Implementation design** — architecture, composition pipeline, sandbox, promotion, design decision record | Developers extending / maintaining it |
| [docs/specification.md](docs/specification.md) | **Specification** — reference for UI Spec / REST API / Ports / component catalog / bridge protocol / environment variables | Developers writing against the implementation |
| [spec/SPEC.md](spec/SPEC.md) | **Kohaku Protocol v0.1** (normative) — MUST/SHOULD and conformance requirements | Building a compatible implementation |
| [python/README.md](python/README.md) | **Python implementation guide** — a wire-compatible full port of the TS implementation (conformance CONFORMANT). Setup, layout, cross-language compatibility guards, known differences | Reading / using the Python implementation |
| [AGENTS.md](AGENTS.md) | Development guide for AI coding agents (commands, conventions, pitfalls). `CLAUDE.md` is a pointer that imports it | AI coding agents |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to set up, verify, and submit changes (also [日本語](CONTRIBUTING.ja.md)) | Contributors |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability, and what is in scope (the `apps/sample-*` demos are not) | Security researchers |

## Install

The reference implementation is published to npm as `@kohaku-ui/*` (all packages share one version) and to
PyPI as `kohaku-ui` (the distribution name; it still imports as `kohaku`).

```bash
# a REST host + the React renderer
npm install @kohaku-ui/host-rest @kohaku-ui/renderer-react @kohaku-ui/composer @kohaku-ui/spec-core zod

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
mkdir my-app && cd my-app
npx @kohaku-ui/cli init --from ../sales.csv   # or a .json array / a .sqlite file
npm run dev
```

Generates a runnable Dashboard + Chat app (DomainPort, Intent catalog, L0 fixed Spec) from your own CSV/JSON/SQLite — see the [Zero-Port quickstart](docs/user-guide.md#zero-port-quickstart-from-your-own-data-no-port-code) for what it produces and how to add L1/L2. The rest of this section is the monorepo's own dev setup.

Prerequisites: Node >= 22, pnpm 12 (the floor is `package.json`'s `engines`; CI verifies on both Node 22 (the declared floor) and Node 24, and `.node-version` pins 25.7.0 for local development).

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
| `packages/otel` | Thin, opt-in OpenTelemetry layer (`createOtelComposeObserver`, combined via composer's `composeObservers`). Depends only on composer (peer: `@opentelemetry/api`); ships no exporter/SDK setup |
| `packages/host-a2ui` | A2UI-compatible profile skeleton (UISpec/SpecPatch → A2UI messages; an independent leaf on spec-core only) [Draft] |
| `packages/client` | Typed host client SDK (depends only on spec-core + data-binding; independent of host-rest) |
| `packages/admin-react` | Governance console (Lineage / Analytics / Promotion review / Fixation) as embeddable React components on top of `client` (the sample's Admin page is a thin wrapper) |
| `apps/sample-api` | Sample: sales-analysis API (**a model implementation of the 4 Ports**) |
| `apps/sample-web` | Sample: Dashboard (GUI) / Chat (NLUI) / Admin (governance) |
| `apps/sample-wc` | Sample: rendering the same Spec with the React-free `<kohaku-surface>` (proof of renderer independence) |
| `apps/sample-mcp` | Sample: MCP server for external chat + the shared renderer |
| `cli/` | `kohaku conformance / scaffold / init / component validate` |
| `python/` | **Python reference implementation** — a wire-compatible full port of the TS `packages/*` (spec / registry / composer / lineage / host-rest / host-mcp) + the sales-api sample. Conformance CONFORMANT. Details in [python/README.md](python/README.md) |

## Development

```bash
pnpm test        # all tests (no LLM required)
pnpm typecheck   # type-check all packages
node cli/bin/kohaku.js conformance --self                                   # spec self-check
node cli/bin/kohaku.js conformance --rest http://localhost:8787/api/kohaku # REST black-box check
```

Onboarding pitfalls worth knowing up front:

- Every workspace directory needs a `vitest.config.ts` (its `name` is what `--project` selects) — one without it makes the root config recurse into itself and fail, so even a package with no tests yet needs a minimal `passWithNoTests: true` config.
- Always run tests from the repository root — with `cwd` inside a package, only that package runs. To run a single package, use `pnpm vitest run --project <name>` (names come from each `vitest.config.ts`'s `name`).
- Never write a test that calls a real LLM. Use `FakeLlm` (`@kohaku-ui/llm/fake`, scripted responses) or `FixtureLlm` (`@kohaku-ui/evals`, record/replay) instead.

Development conventions and pitfalls: [AGENTS.md](AGENTS.md). Out-of-scope items for v0.1: [docs/design.md §14](docs/design.md#14-known-limitations-and-v02-candidates).

---

Copyright 2026 yosuque. Licensed under the [Apache License, Version 2.0](LICENSE).
