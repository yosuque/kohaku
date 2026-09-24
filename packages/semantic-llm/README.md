# @kohaku-ui/semantic-llm

A default `SemanticPort` for kohaku: deterministic GUI normalization, LLM-backed natural-language
normalization against an Intent catalog (structured output, optional catch-all fallback), and query
resolution from `@kohaku-ui/intents` definitions.

```bash
npm install @kohaku-ui/semantic-llm @kohaku-ui/intents @kohaku-ui/llm zod
```

```ts
import { defineIntent } from "@kohaku-ui/intents";
import { createIntentCatalog, createLlmSemanticPort } from "@kohaku-ui/semantic-llm";

const catalog = createIntentCatalog(defs.map((d) => d.toIntentDef()));
const semantic = createLlmSemanticPort({
  llm,
  catalog,
  dataVersion: () => DATA_VERSION,
  describeShape: (ref) => shapeOf(ref.path, ref.params),
});
```

- `IntentCatalog` / `createIntentCatalog(defs)` — a mutable Intent catalog (`get`/`list`/`names`/`normalizeParams`,
  plus `add`/`remove` for promotion and withdrawal) built from `@kohaku-ui/intents` `IntentDef`s.
- `normalizeGuiAction(input, catalog)` — deterministic normalization of GUI operations (`view.select`,
  `facet.change`, and component events with drilldown), never going through the LLM.
- `LlmSemanticPortOptions.fallbackIntent` — the Intent to fall back to (with `params.request` set to the
  raw question) when the model's answer fits no Intent in the catalog; without it, an unmatched question
  throws `SemanticNormalizeError`.
- `LlmSemanticPortOptions.rules` — extra, product-specific system-prompt lines (e.g. fiscal-calendar or
  vocabulary rules) rendered between the generic normalization rules.
- `LlmSemanticPortOptions.onNormalized` — an observation hook called after every natural-language
  normalization (matched or fallback) with `{ text, canonical, fallback, tenant? }`; it never fires before a
  throw, and a throwing hook is caught and ignored (fail-open), so it is safe to use for metrics/logging.

Default SemanticPort: the Intent layer stays a product responsibility
([docs/design.md §2](https://github.com/yosuque/kohaku/blob/main/docs/design.md#2-overall-architecture)) —
this package is a starting point, replace it with your own SemanticPort in production.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/packages/semantic-llm

Licensed under the Apache License, Version 2.0.
