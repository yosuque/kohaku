---
"@kohaku-ui/llm": patch
---

The provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`) are now optional peer dependencies instead of regular dependencies: install only the one(s) for the providers you configure. They were already loaded lazily per provider; a provider whose SDK is not installed now fails with an error naming the package to add.
