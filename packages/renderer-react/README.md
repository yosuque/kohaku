# @kohaku-ui/renderer-react

React renderer for kohaku UI Specs, with the core component implementations.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/renderer-react react react-dom
```

```tsx
import type { BindingClient } from "@kohaku-ui/data-binding";
import { createCoreRegistry } from "@kohaku-ui/renderer-react/core";
import { RendererProvider, SpecView } from "@kohaku-ui/renderer-react";
import type { UISpec } from "@kohaku-ui/spec-core";

function App({ spec, binding }: { spec: UISpec; binding: BindingClient }) {
  return (
    <RendererProvider value={{ impls: createCoreRegistry(), binding, theme: {} }}>
      <SpecView spec={spec} />
    </RendererProvider>
  );
}
```

Subpath entries: `@kohaku-ui/renderer-react/core`

The packages in this scope share a single version and are designed to be installed together.

- Documentation: [docs/user-guide.md — Applying a design system to L2](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#applying-a-design-system-to-l2)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/renderer-react

Licensed under the Apache License, Version 2.0.
