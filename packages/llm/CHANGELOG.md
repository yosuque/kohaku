# @kohaku-ui/llm

## 0.2.0

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`0bea3f0`](https://github.com/yosuque/kohaku/commit/0bea3f047c496e08be629077bdd2018db153dd75) Thanks [@yosuque](https://github.com/yosuque)! - Fix `/lineage` and `/analytics/summary`'s `limit` query parsing, and the LLM retry adapter's `Retry-After` header parsing, to accept only whole decimal-digit strings (rejecting hex, scientific notation, numeric separators, and trailing garbage that a bare `Number`/`parseFloat` would otherwise silently misparse) — closing a TS/Python cross-language divergence on these inputs.

- [#18](https://github.com/yosuque/kohaku/pull/18) [`6e8ae87`](https://github.com/yosuque/kohaku/commit/6e8ae870edb7c1a79a99e126a7e0bf3bacbe1c7f) Thanks [@yosuque](https://github.com/yosuque)! - The provider SDKs (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/openai-compatible`) are now optional peer dependencies instead of regular dependencies: install only the one(s) for the providers you configure. They were already loaded lazily per provider; a provider whose SDK is not installed now fails with an error naming the package to add.
