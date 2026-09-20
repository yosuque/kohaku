# @kohaku-ui/llm

LLM provider abstraction for kohaku: five interchangeable providers with automatic structured-output fallback.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/llm zod
```

Also install the provider SDK(s) you configure — they are optional peer dependencies, not installed automatically: Claude → `@ai-sdk/anthropic`, OpenAI → `@ai-sdk/openai`, Gemini → `@ai-sdk/google`, Ollama / llama.cpp → `@ai-sdk/openai-compatible`. A provider whose SDK is not installed fails at call time with an error naming the package to add.

Subpath entries: `@kohaku-ui/llm/fake`

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/llm

Licensed under the Apache License, Version 2.0.
