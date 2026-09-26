# @kohaku-ui/host

One-call kohaku host: `createKohakuHost()` wires the default Port implementations (in-memory storage, HMAC
capabilities, the LLM-backed SemanticPort) into [@kohaku-ui/host-rest](https://github.com/yosuque/kohaku/tree/main/packages/host-rest),
with every default overridable and an optional MCP Apps subpath.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/host zod
```

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

## MCP Apps

`@kohaku-ui/host/mcp` attaches the same host to an MCP server (`@modelcontextprotocol/server`, an optional
peer dependency — only needed if you import this subpath):

```ts
import { attachKohakuMcp } from "@kohaku-ui/host/mcp";
import { McpServer } from "@modelcontextprotocol/server";

const server = new McpServer({ name: "my-app", version: "1.0.0" });
attachKohakuMcp(server, host, { rendererHtml: () => readRendererBundle() });
```

The packages in this scope share a single version and are designed to be installed together.

- Documentation: [docs/user-guide.md §6](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#6-embedding-it-into-your-own-product)
- Source: https://github.com/yosuque/kohaku/tree/main/packages/host

Licensed under the Apache License, Version 2.0.
