# @kohaku-ui/client

Typed client SDK for a kohaku host: compose, stream, bind, act and the governance endpoints.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/client
```

```ts
import { createKohakuClient, isKohakuHostError } from "@kohaku-ui/client";

const client = createKohakuClient({ baseUrl: "/api/kohaku" });

// synthesis (deterministic path); the response is { spec: UISpec, capability: string }
const { spec, capability } = await client.compose({
  input: { kind: "gui", action: "view.select", params: { intent: "sales.trend" } },
  session: { surface: "web" },
});

try {
  await client.compose({});
} catch (e) {
  if (isKohakuHostError(e) && e.code === "BAD_REQUEST") { /* e.status / e.requestId */ }
}
```

`client.promotions.approve(artifactId, draft, { acknowledgedSuggestion })` forwards `acknowledgedSuggestion` to the host's `POST /promotions/:artifactId/approve` (recorded on the approval's audit event, not enforced).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: [docs/user-guide.md — Calling it from a client](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#calling-it-from-a-client-the-typed-host-client-sdk)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/client

Licensed under the Apache License, Version 2.0.
