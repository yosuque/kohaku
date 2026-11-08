---
"@kohaku-ui/llm": patch
---

Python port (`kohaku-ui` on PyPI): the native `claude` adapter no longer sends `temperature`. Every request on the default (non-injected) path failed with `TypeError: AsyncMessages.create() got an unexpected keyword argument 'temperature'`, because the `anthropic` SDK's `messages.create` has no such parameter; under SDK 2.x's `anthropic-version: 2026-10-21` the Messages API also rejects `temperature` / `top_p` / `top_k` outright. `KOHAKU_LLM_TEMPERATURE` and a per-call `temperature` are still accepted but are not forwarded to Anthropic (kohaku's identical-display guarantee comes from the Spec cache; temperature 0 is only auxiliary). The TypeScript `@kohaku-ui/llm` is unchanged: it carries no code change in this entry and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.
