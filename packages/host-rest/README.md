# @kohaku-ui/host-rest

REST transport profile for a kohaku host.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/host-rest zod
```

```ts
import { Hono } from "hono";
import { createKohakuRoutes, type KohakuHostDeps } from "@kohaku-ui/host-rest";

const deps: KohakuHostDeps = {
  compose,               // a ComposeContext (see @kohaku-ui/composer)
  domain,                // your DomainPort (listOperations / invoke)
  authz,                 // your AuthzPort (issueCapability / verify)
  querySource: "sales",  // the only source allowed for query:// references
};

const app = new Hono();
app.route("/api/kohaku", createKohakuRoutes(deps));
```

The packages in this scope share a single version and are designed to be installed together.

- Documentation: [docs/user-guide.md §6](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#6-embedding-it-into-your-own-product)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/host-rest

Licensed under the Apache License, Version 2.0.
