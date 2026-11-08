---
"@kohaku-ui/llm": patch
---

The `claude` provider now honours `KOHAKU_LLM_BASE_URL` (`LlmConfig.baseUrl`). It was resolved from the environment but never passed to `createAnthropic`, so a gateway or proxy in front of the Anthropic API was silently ignored and requests went to `api.anthropic.com`. `openai` and `gemini` now receive `baseUrl` as well. `LlmConfig` gains an optional, test-only `fetch` (a transport injection point for contract tests; it is never read from the environment). A new wire-contract test runs the real provider SDKs against a scripted transport and pins the URL and auth headers each provider sends.
