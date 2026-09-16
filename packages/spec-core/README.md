# @kohaku-ui/spec-core

Kohaku Protocol core: UI Spec schema, Intent canonicalization, diff/patch, cache keys and the Port types that form the framework boundary.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/spec-core zod
```

```ts
import { computeIntentHash, finalizeIntent } from "@kohaku-ui/spec-core";

// A normalized Intent hashes the same regardless of params key order — the identical-display
// guarantee (and the Spec cache key) is built on this.
const intent = await finalizeIntent({
  canonical: "sales.quarterly_summary",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
});
console.log(intent.hash); // "sha256:<64 hex>"

const same = await computeIntentHash({
  canonical: "sales.quarterly_summary",
  params: { groupBy: "region", quarter: 3, fiscalYear: 2026 },
});
console.log(intent.hash === same); // true
```

The packages in this scope share a single version and are designed to be installed together.

- Documentation: [docs/user-guide.md §1](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#1-what-is-this)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/spec-core

Licensed under the Apache License, Version 2.0.
