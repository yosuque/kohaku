# kohaku Python Implementation

English | [日本語](README.ja.md)

Python reference implementation of Kohaku Protocol v0.1 (the counterpart to the TS
reference implementation `packages/*`). The single source of the contract is the
repository's [`spec/`](../spec/SPEC.md) (SPEC.md + JSON Schema), and it is
wire-compatible with the TS implementation — because canonical JSON is byte-identical,
intent.hash / specHash / cache keys / catalogFingerprint match across languages.

**conformance**: passes **MUST 19/19 = CONFORMANT** under the black-box inspection of
the TS-side CLI (`node cli/bin/kohaku.js conformance --rest`) (including the SHOULD
streaming check; CI's `conformance-python` job inspects it on every commit). The 19 are
the black-box-verifiable MUSTs of the 32 in the conformance manifest; the remaining 13
reference MUSTs (MCPAPP-* / SBX-*, and four documentary Spec-format norms guaranteed by
the TS renderer/composer package tests) are covered by package tests (pytest on this side).

## Setup & verification

Prerequisites: Python 3.12+ + an installation of [uv](https://docs.astral.sh/uv/) itself.

```bash
cd python
uv sync            # install dependencies (uv workspace)
uv run pytest      # all tests (incl. cross-language golden; all pass without a real LLM)
uv run mypy        # type check (strict)
uv run ruff check  # lint
uv run lint-imports # contract check of layer dependency direction (no back-flow) (import-linter)
```

CI (the `python` job in `.github/workflows/ci.yml`) also runs everything in the order
`ruff check` / `mypy` / `lint-imports` / `pytest`.

## Running the sample

```bash
# REST host (:8790; default is the deterministic pseudo-LLM = KOHAKU_LLM_PROVIDER=fake)
uv run python -m sales_api

# To run with a real LLM (local ollama)
KOHAKU_LLM_PROVIDER=ollama KOHAKU_LLM_MODEL=gemma4:e4b uv run python -m sales_api

# conformance black-box inspection (from the repo root; while the server is running)
# NOTE: this CLI runs the TS implementation via tsx, so `pnpm install` must be done at the repo root (node_modules present)
node cli/bin/kohaku.js conformance --rest http://localhost:8790/api/kohaku

# The sales seed dir can be overridden with KOHAKU_SALES_SEED_DIR (defaults to the repo's
# apps/sample-api/src/domain/seed — the Python sample reads that seed JSON directly, see "Structure" below)

# MCP server (stdio; connect to Claude Desktop etc.)
uv run python -m sales_api.mcp_main
# MCP server (Streamable HTTP :8791; to claude.ai / ChatGPT via a public tunnel; auth-less demo)
uv run python -m sales_api.mcp_http
# The ui:// resource serves the shared renderer built on the TS side (a placeholder if not built):
#   pnpm --filter @kohaku-ui-sample/mcp build:renderer
```

## Structure

```
python/
├─ kohaku/                # library proper (the distributable "kohaku")
│  ├─ src/kohaku/
│  │  ├─ spec/             # ← packages/spec-core (schema / canonicalization / validation / Port definitions)
│  │  ├─ registry/         # ← packages/registry (catalog; core is built from the JSON exported by TS)
│  │  ├─ data_binding/     # ← packages/data-binding (reserved-parameter splitting)
│  │  ├─ intents/          # ← packages/intents (Intent DSL)
│  │  ├─ llm/              # ← packages/llm (OpenAI-compatible adapter / FakeLlm)
│  │  ├─ composer/         # ← packages/composer (L0/L1/L2 / single-flight / repair loop; unlike TS,
│  │  │                    #   the tier ladder + single-flight + result assembly are not split out of
│  │  │                    #   compose.py into separate modules — same behavior, coarser file layout)
│  │  ├─ lineage/          # ← packages/lineage (recording / promotion / fixation)
│  │  ├─ evals/            # ← packages/evals (judge / golden / FixtureLlm / distillation dataset export)
│  │  ├─ storage/          # FileStoragePort (equivalent to sample-api's storage-port.ts)
│  │  ├─ host_core/        # ← packages/host-core (framework-free shared host core)
│  │  ├─ host_rest/        # ← packages/host-rest (FastAPI; SPEC §6.1)
│  │  └─ host_mcp/         # ← packages/host-mcp-apps (MCP Apps profile)
│  └─ tests/
└─ examples/
   └─ sales-api/           # ← equivalent to apps/sample-api (REST :8790 + MCP stdio / Streamable HTTP :8791)
```

The dependency direction is the same as TS: `spec → {registry, data_binding, intents} → {composer(llm), lineage} → host_core → {host_rest, host_mcp} → examples`.
`host_core` is a framework-free shared host core consumed by `host_rest` and `host_mcp` as thin adapters (the
same relationship `packages/renderer-core` has with `renderer-react` / `renderer-wc` on the TS side): the
fixation (L1→L0) delivery + staleness self-healing sequence (`compose_with_fixation` / `resolve_fixated_result`
/ `settle_fixation`), capability issuance for a composed Spec (`issue_capability_for_spec`, default TTL 600s),
and fail-open observability-hook helpers (`notify_hook` / `fail_open`) live there once. The two profiles differ
only in how a host schedules the self-heal call (`host_rest` awaits it serialized under its per-tenant fixation
lock; `host_mcp` fires it off as a background task) — that strategy, plus each profile's own error-hook endpoint
strings, stays host-supplied via a small `FixationDeliveryHost` object.

**MCP 2026-07-28 forward-compat** (see `docs/design.md`'s "MCP 2026-07-28 / SDK v2 migration plan" for the
full picture; SDK v2 itself is not adopted yet): `host_mcp` stamps `resultType: "complete"` on every tool
result (TS-symmetric). The correlation id fed to the failure-path observability hook
(`McpErrorInfo.correlation_id`) is **always the tool call's own JSON-RPC request id — never derived from
`_meta.traceparent`** (SEP-414), the same rule TS enforces: a W3C trace-id is shared by an entire trace, so
deriving the correlation id from it would collapse every tool call in one conversation onto the same id.
This id reaches only `McpErrorInfo.correlation_id` today, since `compose_with_fixation` / `ComposeOptions`
carry no correlation-id parameter yet (`host_core`/`composer` are out of scope for that fix), whereas TS's
equivalent additionally reaches `ComposeTrace.correlationId`. A tool call's `_meta.traceparent` (+
`_meta.tracestate`), when well-formed, is separately parsed as a `TraceContext`
(`kohaku.host_core.trace_context`, a straight port of TS's `packages/host-core/src/trace-context.ts` —
including rejecting an all-zero trace-id/parent-id and capping `tracestate` at the W3C-recommended 512
characters; `host_rest` reads the equivalent `traceparent` / `tracestate` request headers) and surfaces the
same way — only on `McpErrorInfo.trace_context` / `HostErrorInfo.trace_context`, never on `ComposeTrace` — for
the same reason. Trace correlation is this `TraceContext`'s job alone; it never doubles as the correlation id.
The OTel SDK itself (span creation/export, `@kohaku-ui/otel`) is TS-only; out of scope for this port.
`host_mcp` additionally stamps `ttlMs`/`cacheScope` (SEP-2549) on
`tools/list` and `resources/list` (not `resources/read`) — the installed `mcp` SDK's low-level decorators
accept a full result object there. TS's `packages/host-mcp-apps` now matches these same values on
`tools/list`/`resources/list` (SDK v2's `ServerOptions.cacheHints`, wired in by `apps/sample-mcp/src/setup.ts`)
and additionally covers `resources/read` on the shared renderer resource (SDK v2's registration-time
`registerResource(..., {cacheHint})`) — a hook this installed `mcp` SDK version's `read_resource()` decorator
still does not expose (it always rebuilds its own `ReadResourceResult` from the handler's
`Iterable[ReadResourceContents]`, with no "new style" full-result return path the way `list_tools`/
`list_resources` have), so `resources/read` stays TS-only.

The Python sample (`examples/sales-api`) reads the seed JSON directly from the
repository root's `apps/sample-api/src/domain/seed` (to avoid maintaining the data
twice). Therefore it assumes a **full monorepo checkout**, not the `python/` subtree
alone.

## How cross-language compatibility is preserved

- **golden fixture**: `spec/test/fixtures/cross-language-canonical.json` is verified by
  both TS (`spec/test/cross-language.test.ts`) and Python
  (`kohaku/tests/spec/test_cross_language_golden.py`). Regeneration is
  `pnpm --filter @kohaku-ui/spec run generate-cross-language-fixtures` (TS is authoritative).
- **core catalog**: `pnpm --filter @kohaku-ui/registry run export-core-catalog` emits
  `registry/_data/core-catalog.json` (CI checks for drift). The fingerprint (fnv1a64) is
  identical to TS, so the cache key matches across languages.
- **canonical JSON**: byte-compatible with JS `JSON.stringify` (reproducing ES number
  notation, numeric-ascending priority for array-index keys, UTF-16 code-unit order
  sorting, and even the escaping of lone surrogates). The implementation is
  `kohaku/src/kohaku/spec/canonical_json.py`.
- **conformance**: CI's `conformance-python` job starts the Python host and runs the
  TS-side CLI's black-box inspection against it.

## Distillation dataset export

`kohaku.evals.export_distillation_dataset` turns human-approved `FixationRecord`s (plus,
optionally, golden regression Specs) into a JSONL distillation dataset — one canonical-JSON
line per Spec, byte-identical to the TS implementation's `exportDistillationDataset`
(`@kohaku-ui/evals`; see `docs/design.md`'s distillation-dataset paragraph for the full field
rundown):

```python
from kohaku.evals import export_distillation_dataset
from kohaku.spec import FixationRecord

fixations: list[FixationRecord] = [...]  # e.g. loaded from a fixations.json snapshot
jsonl = export_distillation_dataset(
    fixations,
    golden=None,  # optional: supplementary golden regression Specs
    tenant="tenant-a",  # optional: restrict the export to one tenant's fixations
)
with open("dataset.jsonl", "w", encoding="utf-8") as f:
    f.write(jsonl)
```

Each line is `{intent, refs, shape?, target: {components, events}, source: "fixation"|"golden",
meta}`; for a `"fixation"` row, `meta` also carries `tenant` / `catalogFingerprint` when the
record has them, and is omitted per-key (not written as `null`) when the record predates that
field — this keeps output byte-identical to the TS side, whose `undefined` keys are dropped by
`JSON.stringify` the same way. There is no Python CLI counterpart; the TS side's
`kohaku dataset export` (`cli/bin/kohaku.js`) is the ready-made file-based entry point and works
against either language's fixations, since the wire shape is identical.

## Opt-in prompt caching / `refConstraint` (symmetric with TS)

Two independent, opt-in escape hatches for the trade-off between kohaku's schema-level
`data.$ref` forgery-proofing (decision #4 in TS's `docs/design.md` §13) and provider-side
structured-output grammar caching are implemented symmetrically here, both defaulted off:

- `KOHAKU_LLM_PROMPT_CACHE=1` opts the `claude` provider into Anthropic prompt caching
  (`kohaku.llm.env.LlmConfig.prompt_cache`; `anthropic_native.py`'s `_user_content` splits
  the user message into two content blocks and marks the leading one with
  `cache_control: {"type": "ephemeral"}` — a no-op for every other provider or whenever the
  caller passes no `PromptParts`).
- `ComposePolicy.refConstraint: "schema" | "validate"` (default `"schema"`, unchanged)
  relaxes the L1 generation schema's `data.$ref` to a plain string under `"validate"`
  (`build_l1_generation_schema` in `kohaku.composer.l1_generate`) and instead validates
  set-membership explicitly after generation, feeding a `DATA_REF_UNRESOLVED` finding back
  into the existing repair loop.

See TS's `docs/design.md#prompt-caching` (and its Japanese counterpart) for the full
trade-off and the measurement script (`apps/sample-api/scripts/measure-grammar-latency.ts`)
used to decide whether either is worth turning on for a given model/provider.

## Reasoning effort / per-tier LLM (symmetric with TS)

Two additive, opt-in knobs mirror the TS side exactly (both defaulted off/unset; leaving
either untouched reproduces the pre-existing cacheKey byte-for-byte):

- **`ComposePolicy.effort: EffortPolicy(l1=..., l2=...)`** threads an Adaptive Reasoning
  effort level (`kohaku.llm.LlmEffort` — `"low" | "medium" | "high" | "xhigh" | "max"`)
  independently into the L1 (`l1_generate.py`) and L2 (`l2_generate.py`) generation calls
  as `GenerateObjectRequest`/`GenerateTextRequest.effort`. Wired per provider in the
  adapters: `claude` sends `output_config={"effort": ...}` (verified against the installed
  `anthropic` SDK's `OutputConfigParam` — `anthropic_native.py`'s `_output_config_params`);
  `openai`/`ollama`/`llama` (the shared `openai_compat.py` adapter) send `reasoning_effort`
  at the top level of the chat.completions body (verified against `@ai-sdk/openai` and
  `@ai-sdk/openai-compatible`'s own request-building code, which write the same wire
  field); `gemini` has no matching option in the installed `google-genai` SDK and silently
  ignores it. A port that does not implement effort control (`FakeLlm`) ignores the field.
  Participates in `policy_fingerprint` whenever `ComposePolicy.effort` is set at all (same
  contract as `refConstraint` above).
- **`ComposeContext.llmByTier: TierLlm(L1=..., L2=...)`** overrides the base `llm` per
  tier (`resolve_tier_llm`, called from `l1_generate.py`/`l2_generate.py`), letting an
  operator plug a small fine-tuned model — the distillation dataset above targets exactly
  L1's constrained-generation task — into L1 while keeping a larger model for L2, or vice
  versa. `TierLlmFingerprintMaterial` (`tier_llm_fingerprint_material`) folds the resolved
  tier ports' `{provider, model_id}` into `policy_fingerprint`'s second argument, but
  **only when a set tier's model genuinely differs from the base `llm`'s** — an override
  that happens to match the base model changes nothing.
- **Bug fix carried over from the TS side's WP2**: L2's `TierResult.model` (surfaced on
  `ComposeTrace`) now reads the *resolved* tier port's `model_id` rather than
  unconditionally the base `llm`'s — `generate_text`'s result carries no `model` field of
  its own, so `l2_generate.py` has always substituted the calling port's own `model_id`,
  but previously that was the base port even when `llmByTier.L2` was in play.
- **`DEFAULT_MODELS["claude"]`** (`kohaku.llm.env`) moved from `"claude-sonnet-4-6"` to
  `"claude-sonnet-5"`, matching TS's `env.ts`. Since the model id is part of
  `default_generator_version`, this changes the *default* cacheKey for any operator who
  never sets `KOHAKU_LLM_MODEL`; `openai`/`gemini`/`ollama`/`llama` defaults are untouched.

## Compose-wide wall-clock deadline (symmetric with TS, including in-flight abort)

`ComposeBudget.deadline_ms` (a sibling of `per_compose_stop_after_tokens`) bounds the wall-clock time of one
whole `compose`/`compose_stream` call, in milliseconds elapsed since the compose started. Unset (the
default) is byte-identical to before this field existed: no timer, no extra clock read, and the abort
signal passed to LLM calls is `ComposeOptions.abort` verbatim.

Because Python's `kohaku.llm.abort` module already reimplements the Web `AbortSignal`/`AbortController`
surface (`AbortSignal.timeout` / `AbortSignal.any`, used throughout `adapters/_base.py`), this feature ports
**with no loss of fidelity** — both halves of the TS design carry over exactly:

- **Between-call enforcement**: `check_budget` gained an optional `elapsed_ms` parameter (still a pure
  function — the caller supplies elapsed time; `check_budget` never reads the clock itself) and checks it
  right after `per_compose_stop_after_tokens` and before the `check()` hook, with a `"...deadline...ms
  reached..."` reason distinguishable from the token-threshold one.
- **In-flight enforcement**: `create_deadline_guard(budget, started_at, caller_signal, now=None)`
  (`budget.py`) arms `AbortSignal.timeout(remaining_ms)` once per compose (in `compose.py`'s
  `_run_tier_generation`, shared across the initial L1 call, every repair re-attempt, and L2) and combines
  it with the caller's own signal via `AbortSignal.any`, so an in-flight call is genuinely aborted mid-call
  when the deadline elapses — not merely prevented from starting the *next* call.
- **The classification subtlety carries over exactly**: `create_deadline_guard` hands back a second, narrower
  `deadline_signal` armed by nothing else. `generate_l1`/`generate_l2` check `deadline_signal.aborted` at the
  point they catch an `ABORTED` `LlmError` and classify it as `failure="budget"` (the *same* classification
  as a between-call skip, `budgetReason` included) rather than `"aborted"` — so the resulting fallback is
  `budgetExceeded=True` and is **not** marked `trace.cancelled`, while a genuine caller `AbortSignal` firing
  is still classified as cancelled exactly as before. This is the whole point of the feature (an
  operator-configured deadline must count toward the generation-fallback rate, unlike a client disconnect),
  and the Python and TS implementations agree on every case in `kohaku/tests/composer/test_deadline.py`
  (a pytest port of TS's `deadline.test.ts`), including the in-flight-abort-vs-cancellation test.
- **One internal (non-wire) unit adaptation**: `PreparedCompose.started_at` already uses `time.monotonic()`
  seconds (not `Date.now()` milliseconds like TS), so `create_deadline_guard`'s `started_at`/`now` are in
  that same unit — only `ComposeBudget.deadline_ms` itself stays in milliseconds, matching the field's name
  and TS's meaning exactly. This is invisible to callers; it only affects how the guard's internals compute
  `remaining_ms`.
- Timer hygiene (disposed in `_run_tier_generation`'s `finally`) matches TS's `runTierGeneration`.

## Known differences from the TS implementation (intentional & permanent)

- **JS validation is delegated to a Node sidecar (skipped only when standalone)**: the
  L2 contract lint's `L2_SCRIPT_SYNTAX` (JS syntax check) and `ComposePolicy.l2Smoke`
  (pre-delivery smoke validation) are provided by subprocess delegation to the TS CLI
  bundled in the repository (`kohaku smoke-l2`) (`kohaku.composer.create_l2_js_sidecar`;
  sales-api enables it by default via Node co-location detection, and it is disabled with
  `KOHAKU_L2_JS=off`). The validation logic is single-sourced on the TS side and not
  implemented twice. **In a standalone deployment without a co-located Node, it
  fail-open skips as before** (the spec's provision to "skip in environments where dynamic
  code generation is not possible"). The injection point for the syntax check is the
  Python-specific `ComposePolicy.l2ScriptSyntax` (there is no corresponding field in TS
  because it is built in).
- **Streaming (`stream_object`) language adaptation**: TS's `streamObject?` (optional
  method + intersection type) has no corresponding syntax in Python, so optionality is
  expressed with `StreamingLlmPort` (a separate Protocol) + a `supports_streaming()`
  TypeGuard, and `on_partial` is received as a **second argument** rather than composed
  into the request. The contract (cumulative partial / best-effort / exception swallowing)
  and wire behavior are identical to TS.
- **`BindingClient.resolve` returns a raw payload (JsonObject)** (TS returns a structural
  TabularData). This is because Python's `TabularData` (pydantic) requires dataVersion and
  cannot express the leniency of the object boundary that the SPEC treats as SHOULD
  (omittable). The shallow shape check and STALE reconciliation logic are identical to TS.
- Means of implementing the LLM adapter: TS goes via the Vercel AI SDK, while Python calls
  each vendor's SDK / httpx directly (openai-compatible = httpx, claude = the `anthropic`
  SDK's (`>=1.0`) strict forced tool-use with `strict: true` on the forced tool, gemini =
  google-genai's response_json_schema). **The behavior (fallback decision / retry / error
  classification) is identical**, and the difference is only the means of implementation.
  Anthropic's structured-output JSON Schema subset rejects several keywords the registry's
  generation schema can contain (`minLength` / `maxLength` / `pattern` / `minimum` /
  `maximum` / `multipleOf` / `minItems` beyond 0-1 / `maxItems` / `uniqueItems` /
  recursive `$ref`, and requires `additionalProperties: false`); `anthropic_native.py`'s
  `_sanitize_for_anthropic` strips the unsupported keywords before sending and folds each
  into the node's `description` in English (the same transform `@ai-sdk/anthropic`'s
  `sanitizeJsonSchema` performs, so the TS and Python adapters degrade the same way for the
  same schema). Validation of the returned object still uses the original, unsanitized
  schema.
- Internal APIs (functions and methods that do not appear on the wire) follow Python's
  snake_case convention. The wire shapes (JSON keys, endpoints, _meta keys) match TS
  exactly.

> Updated 2026-07-18 (previously-listed differences now resolved): ① minimal per-tenant
> reconcile for promotion → fully ported PromotedRegistry / projection / startup reconcile
> to sales-api ② interim patch (0..N) for compose streaming → brought to parity with TS
> ③ LLM adapter "OpenAI-compatible only" → added native claude / gemini adapters
> (`uv sync --package kohaku --extra claude` / `--extra gemini`) ④ partial semver range
> implementation → completed to node-semver compliance (comparison operators, whitespace
> AND, `||` OR, hyphen, x-range, tilde/caret, prerelease exclusion rule; build metadata is
> ignored in comparison; invalid ranges are fail-closed) ⑤ BindingClient not ported →
> ported as `kohaku.data_binding.create_binding_client` (the default HTTP fetcher is httpx,
> optional) ⑥ interrupt propagation on client disconnect → wired up
> (`request.is_disconnected()` polled every ~250ms → AbortSignal → single-flight interrupt
> vote = symmetric with the TS implementation) ⑦ lineage id → changed from uuid4 hex to the
> same ULID as TS (own implementation, Crockford Base32 26 chars), so the chronological
> ordering of the audit (lexicographic order) matches across languages.
