# @kohaku-ui/semantic-llm

A default `SemanticPort` for kohaku: deterministic GUI normalization, LLM-backed natural-language
normalization against an Intent catalog (structured output, optional catch-all fallback), and query
resolution from `@kohaku-ui/intents` definitions.

- `IntentCatalog` / `createIntentCatalog(defs)` — a mutable Intent catalog (`get`/`list`/`names`/`normalizeParams`,
  plus `add`/`remove` for promotion and withdrawal) built from `@kohaku-ui/intents` `IntentDef`s.
- `normalizeGuiAction(input, catalog)` — deterministic normalization of GUI operations (`view.select`,
  `facet.change`, and component events with drilldown), never going through the LLM.

Default SemanticPort: the Intent layer stays a product responsibility (docs/design.md §2) — this package
is a starting point, replace it with your own SemanticPort in production.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/semantic-llm

Licensed under the Apache License, Version 2.0.
