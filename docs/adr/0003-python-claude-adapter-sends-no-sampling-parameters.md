# 0003. The Python claude native adapter sends no sampling parameters

- Status: accepted
- Date: 2026-11-08
- Deciders: yosuque + Claude Code
- Phase: implementation

## Context and problem

The Python port's native `claude` adapter (`python/kohaku/src/kohaku/llm/adapters/anthropic_native.py`) passed `temperature=` to `AsyncAnthropic.messages.create`. The anthropic Python SDK has no such keyword, in any version from 1.5.0 (the floor of the `claude` extra) to 1.15.0, nor in 2.x. Every request on the default path therefore failed with `TypeError: AsyncMessages.create() got an unexpected keyword argument 'temperature'`, and the released `kohaku-ui` 0.5.0 has the same bug. It went unnoticed for two reasons. The tests always inject an `AnthropicTransport`, so the SDK path never ran. And mypy cannot see through `create(**params)` with `params: dict[str, Any]`.

The bug surfaced while reviewing Dependabot #93, which moved the lock from anthropic 1.15.0 to 2.3.0. SDK 2.x sends `anthropic-version: 2026-10-21` by default instead of `2023-06-01`. Under that API version the Messages API returns 400 for any request that carries `temperature`, `top_p` or `top_k`, even at the default value, and Claude 4.7 and later models accept only the default sampling anyway.

kohaku's identical-display guarantee comes from the Spec cache, and temperature 0 is only an auxiliary measure (AGENTS.md, "Composer caching"). The TypeScript `@kohaku-ui/llm` sends `temperature` through `@ai-sdk/anthropic`, which still sends `anthropic-version: 2023-06-01` (checked up to 4.0.99).

## Options considered

- **Option A**: stop sending `temperature` (and any other sampling parameter) on the Python claude native path.
- **Option B**: keep sending it, but through `extra_body`, and pin `anthropic-version: 2023-06-01` with a default header, which keeps parity with TypeScript.
- **Option C**: cap the extra at `anthropic<2` and send `temperature` through `extra_body`.
- **Option D**: leave the adapter as it is.

## Decision

Chosen: **Option A**

### Rationale

- It works on every SDK version the extra allows, 1.x and 2.x, and on the current API version. `KOHAKU_LLM_TEMPERATURE` and a per-call `temperature` are still accepted by the port but are not forwarded to Anthropic.
- Nothing kohaku guarantees depends on the parameter. Identical display comes from the cache, and Claude 4.7 and later models accept only the default sampling.
- Option B keeps the adapter on an old API version. It works against the SDK's own types (the parameter is not part of `messages.create`), and the adapter would break again if `2023-06-01` were retired or a feature came to require the new version.
- Option C blocks SDK upgrades for every user of the `claude` extra in order to keep a parameter whose effect is auxiliary.
- Option D keeps the adapter broken for every real call.

## Consequences (trade-offs)

- Good: the Python claude path works again (#104). A new regression test (`python/kohaku/tests/llm/test_anthropic_native_sdk.py`) drives the real SDK client through `httpx2.MockTransport`. It asserts that the call does not raise `TypeError` and that no sampling parameter appears in the request body, and it passes against anthropic 1.15.0 and 2.3.0. Dependabot #93 (anthropic 2.3.0) could be merged after this change.
- Costs / bad: on models that still accept other values (Claude Sonnet 4.6 and earlier), the temperature-0 nudge toward consistent output is lost. Python and TypeScript now deliberately send different request parameters to Anthropic; this is documented in `python/README*.md` and `docs/specification*.md`. The fix reaches PyPI only with the next release.
- Revisit when: `@ai-sdk/anthropic` moves to `anthropic-version: 2026-10-21` (then the TypeScript path hits the same 400 and should stop sending sampling parameters too, and the two ports realign); or Anthropic adds a replacement control for output consistency.
- Not covered by this decision: SDK 2.x also sends the API key as `Authorization: Bearer` instead of `X-Api-Key`. A custom `KOHAKU_LLM_BASE_URL` gateway that reads `x-api-key` may answer 401. That is tracked as a separate follow-up.

## References

- PRs: #104 (the fix), #93 (anthropic 2.3.0 in the lock)
- Anthropic, "Migrating to API version 2026-10-21", "Sampling parameters are removed": https://platform.claude.com/docs/en/api/migration-2026-10-21
- [ADR-0002](0002-update-dependencies-lockfile-only-with-cooldown.md): the update policy under which the 2.x major was reviewed separately
