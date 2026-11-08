You are adding kohaku (https://github.com/yosuque/kohaku) to an existing MCP server.
Work in small steps and run the project's own tests after each one.

GOAL
Make the tool <TOOL, e.g. sales_summary> answer with a rendered screen (an MCP Apps widget)
instead of a wall of text, with the same screen every time for the same request.

INSTALL
npm i @kohaku-ui/host @kohaku-ui/host-mcp-apps @kohaku-ui/intents @kohaku-ui/llm @kohaku-ui/mcp-renderer @kohaku-ui/spec-core @modelcontextprotocol/server zod
npm i hono @hono/node-server    # only for the conformance check below
npm i -D tsx
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # writes ports.ts and intents.ts (server.ts: ignore)

RULES
1. Never put row data in a Spec or in the tool's text. The Spec carries query:// references;
   the widget fetches rows itself, so no row ever enters the model's context.
2. Every write is a DomainPort operation declared in listOperations() with a paramsSchema
   and a tier ("auto" | "confirm" | "approve"). Never mutate inside a read operation.
3. Tests never call a real LLM: use FakeLlm from @kohaku-ui/llm/fake.

STEPS
1. DomainPort: fill kohaku/ports.ts so listOperations/invoke call the server's EXISTING data
   access (reuse it, do not copy data).
2. Intent: one defineIntent per tool in kohaku/intents.ts (canonical name, Zod params,
   queries). Its `source` must equal createKohakuHost's querySource.
3. Host: const host = createKohakuHost({ domain, querySource, llm: createLlmFromEnv(),
   intents: intents.map((i) => i.toIntentDef()), dataVersion }). Set KOHAKU_CAPABILITY_SECRET
   (dev: true is for a local trial only).
4. MCP: attachKohakuMcp(server, host, { rendererHtml: loadRendererHtml, intentTools:
   intentToolsFromCatalog(intents.map((i) => i.toToolSource())) }) with attachKohakuMcp from
   @kohaku-ui/host/mcp, loadRendererHtml from @kohaku-ui/mcp-renderer; run the server over stdio.
5. Register it (Claude Code: claude mcp add --env KOHAKU_CAPABILITY_SECRET=<secret> <name> --
   npx tsx ./server.ts) and call the tool; each Intent becomes a tool, dots become underscores.

DONE WHEN
- serving host.app with @hono/node-server, npx @kohaku-ui/cli conformance --rest
  http://localhost:<port>/api/kohaku reports CONFORMANT;
- the registered tool returns a Spec plus a text summary, and the project's tests pass.
