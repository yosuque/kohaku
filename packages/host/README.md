# @kohaku-ui/host

One-call kohaku host: `createKohakuHost()` wires the default Port implementations (in-memory storage, HMAC
capabilities, the LLM-backed SemanticPort) into [@kohaku-ui/host-rest](https://github.com/yosuque/kohaku/tree/main/packages/host-rest),
with every default overridable and an optional MCP Apps subpath.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/host @kohaku-ui/llm @ai-sdk/anthropic @hono/node-server zod
```

(`@ai-sdk/anthropic` is the provider SDK for Claude, used by `createLlmFromEnv()`; swap it for the provider you configure.)

```ts
import { serve } from "@hono/node-server";
import { createKohakuHost } from "@kohaku-ui/host";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { createDomainPort, shapeOf } from "./domain-port.js";
import { DATA_VERSION } from "./dataset.js";
import { INTENT_DEFINITIONS, SOURCE } from "./intents.js";

const { app } = createKohakuHost({
  intents: INTENT_DEFINITIONS.map((d) => d.toIntentDef()),
  domain: createDomainPort(),
  querySource: SOURCE,
  llm: createLlmFromEnv(),
  dataVersion: () => DATA_VERSION,
  describeShape: (ref) => shapeOf(ref.path, ref.params),
});

serve({ fetch: app.fetch, port: 8787 });
```

Every default (`storage`, `authz`, `semantic`, `catalog`) can be overridden with your own Port
implementation; the contract is [@kohaku-ui/spec-core](https://github.com/yosuque/kohaku/tree/main/packages/spec-core)'s
`ports.ts`. `kohaku init` generates a project wired this way.

Two options reach past the defaults:

- `routes` passes every other `KohakuHostDeps` field straight to `createKohakuRoutes` — `auth` / `tenant` (JWT and
  multi-tenant resolution), `approvals` / `actionAuditRecorder` / `actionEffects` (governed Actions),
  `rateLimiter`, `authorizeGovernance`, `promotions` / `fixations`, and so on.
- `recorder` is the View Lineage recorder. By default every compose is recorded into `host.lineage` (built over
  the host's own `storage`), which is what `kohaku explain`, DevTools and the evidence pack read; pass your own
  recorder to replace it or `false` to record nothing. Persist `storage` (Redis / Postgres) if the lineage must
  outlive the process.

`fallbackIntent` and `rules` are passed through to the default SemanticPort (`createLlmSemanticPort`).

The default `authz` needs a capability secret: set the `KOHAKU_CAPABILITY_SECRET` environment variable
(`kohaku init` generates one into a project's `.env`) or pass `capabilitySecret`. Without either,
`createKohakuHost` throws — pass `dev: true` for a temporary, randomly generated secret instead (local
development only; every capability issued under it is invalidated on restart).

## MCP Apps

`@kohaku-ui/host/mcp` attaches the same host to an MCP server. Both `@kohaku-ui/host-mcp-apps` and
`@modelcontextprotocol/server` are optional peer dependencies — neither is installed by a plain
`npm install @kohaku-ui/host`; install both yourself to use this subpath:

```bash
npm install @kohaku-ui/host-mcp-apps @kohaku-ui/mcp-renderer @modelcontextprotocol/server
```

```ts
import { createKohakuHost } from "@kohaku-ui/host";
import { attachKohakuMcp } from "@kohaku-ui/host/mcp";
import { loadRendererHtml } from "@kohaku-ui/mcp-renderer";
import { McpServer } from "@modelcontextprotocol/server";

const host = createKohakuHost({ /* as above */ });
const server = new McpServer({ name: "my-app", version: "1.0.0" });
attachKohakuMcp(server, host, { rendererHtml: loadRendererHtml });
```

The MCP profile shares the host's Ports, reports failures through the same console error reporter as REST
(`onError`) and records into the same lineage. `attachKohakuMcp`'s `deps` option passes any other
`McpHostDeps` field through (`resolvePrincipal`, `approvals`, `rateLimiter`, ...).

The packages in this scope share a single version and are designed to be installed together.

- Documentation: [docs/user-guide.md §6](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#6-embedding-it-into-your-own-product)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/host

Licensed under the Apache License, Version 2.0.
