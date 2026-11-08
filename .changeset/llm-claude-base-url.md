---
"@kohaku-ui/llm": patch
---

**Behaviour change** — `KOHAKU_LLM_BASE_URL` is now honoured by `claude`, `openai` and `gemini` in the TypeScript package. It was resolved from the environment but only ever passed to the `ollama` / `llama` provider, so a gateway or proxy in front of the Anthropic, OpenAI or Gemini API was silently ignored and requests went to the vendor's default endpoint. **A value left over in your environment for Ollama will now redirect those providers too: unset it when you switch provider.** An empty value is ignored.

The value's convention is now defined per provider and is identical in the TypeScript and Python ports: for `claude` and `gemini` it is the vendor root without the API-version path (`https://gw.example`; a trailing `/v1` / `/v1beta` is accepted and stripped, so both spellings reach the same URL), for `openai` / `ollama` / `llama` (OpenAI-compatible) it includes `/v1` and is used as given. In Python this changes `claude` / `gemini` only for a value that ended in `/v1` / `/v1beta` (the SDKs append the version themselves, so such a value used to produce `/v1/v1/messages`).

**Behaviour change** — the TypeScript `claude` provider no longer sends `temperature` (the same as the Python port, ADR-0003): from `anthropic-version` 2026-10-21 the Messages API rejects sampling parameters, and `@ai-sdk/anthropic` already dropped it for current models while logging an `AI SDK Warning` on every call. `KOHAKU_LLM_TEMPERATURE` and a per-call `temperature` are still accepted; every other provider still receives them.

Python port: when a base URL is configured, the `claude` adapter also sends `X-Api-Key: <key>` next to the SDK's own auth header (`anthropic` SDK 2.x authenticates `api_key=` with `Authorization: Bearer`), so a gateway that reads only `x-api-key` keeps working. Without a base URL the request is left exactly as the SDK builds it.

`LlmConfig` gains an optional, test-only `fetch` (a transport injection point; never read from the environment). New wire-contract tests run the real provider SDKs against a scripted transport in both languages and pin the final URL and auth headers each provider sends, with the base-URL cases shared through the cross-language golden fixture.
