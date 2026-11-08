# 0009. An LLM base URL is the vendor API root, normalised the same way in TS and Python

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

The wire-contract tests added in PR #115 (real provider SDKs over a fake transport) found two problems with `KOHAKU_LLM_BASE_URL`. First, the TypeScript claude provider ignored it: `config.baseUrl` was never passed to `createAnthropic`. Second, once honoured, the same value meant different things in the two languages. `@ai-sdk/anthropic` takes a `baseURL` that includes `/v1` (`https://gw.example/v1` gives `/v1/messages`), while the Python `anthropic` SDK appends `/v1/messages` itself, so `https://gw.example/v1` produced `/v1/v1/messages`. Gemini has the same split with `/v1beta`.

A related finding concerned authentication. The Python anthropic SDK 2.x sends the key as `Authorization: Bearer` and no longer sends `X-Api-Key`, so a custom gateway that reads only `x-api-key` may answer 401 (the item ADR-0003 left outside its scope).

## Options considered

The wp-e4 report states the base-URL question as "normalise one side, or document it".

- **Option A**: the vendor API root is canonical for claude and gemini, and both languages normalise the value, so the root and the versioned form resolve to the same request URL in both.
- **Option B**: normalise in one language only.
- **Option C**: leave the behaviours different and document the difference per language.

For authentication:

- **Option D**: keep the SDK's `Authorization: Bearer` and additionally send `X-Api-Key` when a gateway is configured.
- **Option E**: keep the SDK default alone, which leaves the 401 risk for `x-api-key`-only gateways.

## Decision

Chosen: **Option A** and **Option D**

- **Convention**: for claude and gemini, `KOHAKU_LLM_BASE_URL` is the vendor root, for example `https://gw.example` or `https://gw.example/anthropic`. Normalisation trims, strips trailing slashes and strips one trailing `/v1` (claude) or `/v1beta` (gemini). TypeScript re-adds the version because `@ai-sdk/anthropic` and `@ai-sdk/google` want the versioned base. Python passes the root because its SDKs add the version.
- **Unchanged**: openai, ollama and llama keep the OpenAI-compatible convention, where the value includes `/v1` and is not normalised. An empty or blank value is ignored everywhere.
- **Pinned**: a cross-language golden `llmBaseUrl` (20 cases) holds the normalised root and, for claude and gemini, the final request URL that the real SDK must hit. The TS and Python wire tests read the same fixture.
- **TS fix**: `baseURL` is now passed for claude, openai and gemini.
- **Python auth**: the claude adapter keeps the SDK's Bearer default and sends `X-Api-Key` through `default_headers` only when a base URL is configured and a real key is configured (not the `not-required` placeholder). The tests do not depend on the SDK major version.

### Rationale

- With a vendor root, a user copies the same value for both languages and gets the same request URL; neither a `/v1` nor a missing `/v1` breaks.
- Normalising in both languages is what makes that true; normalising one side only would leave the other reading the value differently.
- Adding `X-Api-Key` only for a configured gateway keeps the default path exactly as the SDK sends it, while keeping `x-api-key`-only gateways working.

## Consequences (trade-offs)

- Good: one value works across languages for claude and gemini, the `/v1/v1` failure is gone, and the Python claude path works behind `x-api-key` gateways.
- Costs / bad:
  - **Behaviour change**: the variable is now honoured for claude, openai and gemini in TypeScript, so a value left over for ollama will redirect those providers. The changeset and the user guide say so.
  - The convention is per provider (the root for claude and gemini, the OpenAI-compatible form for the others), which has to be documented in the specification and user guide.
  - Whether the live Anthropic API accepts a Bearer-wrapped API key under `anthropic-version: 2026-10-21` could not be checked offline. The SDK sending it by design suggests yes.
- Revisit when: the unverified Bearer behaviour turns out to be rejected by the live API, or the SDK's default authentication header changes.

## References

- PR: #115
- [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.md): the "not covered by this decision" note on `Authorization: Bearer` that this ADR resolves
- [ADR-0010](0010-ts-claude-path-sends-no-sampling-parameters.md): the other decision from the same PR
