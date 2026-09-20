# @kohaku-ui/composer

UI Composition Service for kohaku: L0/L1/L2 generation, the repair loop, deterministic post-processing and the Spec cache.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/composer zod
```

```ts
import { compose, type ComposeContext } from "@kohaku-ui/composer";

// catalog: from @kohaku-ui/registry's resolveCatalog(coreCatalog); semantic/storage: your Ports;
// llm: an LlmPort, e.g. @kohaku-ui/llm's createAiSdkLlm(...)
const ctx: ComposeContext = { catalog, semantic, storage, llm };

const { spec, trace } = await compose(
  { kind: "intent", intent: { canonical: "sales.trend", params: {} } },
  ctx,
);
console.log(trace.tier); // "L0" | "L1" | "L2" — which pipeline stage produced this Spec
```

Subpath entries: `@kohaku-ui/composer/l2-api`, `@kohaku-ui/composer/design-system`

The packages in this scope share a single version and are designed to be installed together.

- Documentation: [docs/user-guide.md §7](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#7-operational-tips)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/composer

Licensed under the Apache License, Version 2.0.
