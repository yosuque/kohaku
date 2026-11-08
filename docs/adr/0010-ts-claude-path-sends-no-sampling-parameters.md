# 0010. The TypeScript claude path sends no sampling parameters

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

[ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.md) made the Python claude native adapter stop sending `temperature` and the other sampling parameters. It listed the resulting difference as a cost (Python and TypeScript send different request parameters to Anthropic) and gave a revisit condition under which the two ports should realign: `@ai-sdk/anthropic` moving to `anthropic-version: 2026-10-21`.

That literal condition has not occurred. The trigger was found by the wire-contract tests in PR #115, which run the real `@ai-sdk/anthropic` over a fake transport. kohaku passes `temperature: 0` to the AI SDK, and for current claude models (the test used `claude-sonnet-5`) `@ai-sdk/anthropic` drops it from the request body and writes an `AI SDK Warning` to stderr on every call. So TypeScript was already sending no `temperature` on the wire for those models, while still emitting a warning on each call. The wp-e4 report flagged this as open question 3: harmless, but avoidable.

As in ADR-0003, the identical-display guarantee comes from the Spec cache and temperature 0 is only auxiliary (AGENTS.md, "Composer caching").

## Options considered

- **Option A**: the TypeScript claude provider no longer passes `temperature` (or any sampling parameter) to the AI SDK. Other providers are unchanged.
- **Option B**: keep passing `temperature` and suppress the SDK warning. The first draft of the test did this with a file-scope `AI_SDK_LOG_WARNINGS = false`.
- **Option C**: leave the adapter as it was and accept the warning on every claude call.

## Decision

Chosen: **Option A**

`samplingOptions()` in `packages/llm/src/adapters/ai-sdk.ts` omits `temperature` for `claude` only, and every call site shares it through `baseCallOptions`. ollama, llama, openai and gemini are unchanged (ollama still sends `temperature: 0` on the wire). Tests pin the claude request body: no `temperature`, `top_p` or `top_k` for `generateObject`, a per-call override, `generateText` and the stream path, and the SDK's warning handler records nothing. The file-scope warning suppression was removed.

### Rationale

- The behaviour on the wire for current models does not change; what changes is that the warning disappears and the code states what is actually sent.
- It extends ADR-0003's reasoning to TypeScript: nothing kohaku guarantees depends on the parameter, and Claude 4.7 and later models accept only the default sampling.
- Option B would keep sending a parameter the SDK discards, and hide a warning that tells the truth about it. Option C leaves a warning on every call.
- It realigns the two ports as ADR-0003 anticipated, without waiting for the API-version condition.

## Consequences (trade-offs)

- Good: both ports now send no sampling parameters to Anthropic, which closes the divergence that ADR-0003 listed under its costs. The per-call stderr warning is gone. python/README no longer says that TypeScript still sends `temperature`.
- Costs / bad: on older Claude models that still accept other values, TypeScript also loses the temperature-0 nudge toward consistent output, as Python already did. The model-dependent behaviour is no longer visible in the TypeScript request.
- Revisit when: Anthropic adds a replacement control for output consistency (the second revisit condition of ADR-0003).

## References

- PR: #115
- [ADR-0003](0003-python-claude-adapter-sends-no-sampling-parameters.md): extended to TypeScript by this ADR. ADR-0003 is not superseded and is left unedited.
- [ADR-0009](0009-llm-base-url-is-the-vendor-api-root.md): the other decision from the same PR
