You are adding kohaku (https://github.com/yosuque/kohaku) to an existing MCP server. Work in
small steps and run the project's own tests after each one.

GOAL
Make the tool <TOOL, e.g. sales_summary> answer with a rendered screen (an MCP Apps widget)
instead of text, with the same screen every time for the same request.

INSTALL
npm i @kohaku-ui/host @kohaku-ui/host-mcp-apps @kohaku-ui/intents @kohaku-ui/composer @kohaku-ui/llm @kohaku-ui/mcp-renderer @kohaku-ui/spec-core @modelcontextprotocol/server zod
npm i -D tsx hono @hono/node-server   # hono and node-server only serve the conformance check
npm pkg set type=module               # top-level await needs ESM
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # writes ports.ts and intents.ts (ignore server.ts)

RULES
1. Never put row data in a Spec: Specs carry query:// references, and rows reach the screen
   only through DomainPort.invoke, with a capability the host issues.
2. Every write is a DomainPort operation in the operation list, with a paramsSchema and a
   tier ("auto" | "confirm" | "approve"). Never mutate inside a read operation.
3. Tests never call a real LLM: use FakeLlm.
4. Demo auth and dev mode are localhost-only. Before anyone else can reach the host, wire real
   authentication and governance authorization (else every request runs as ANONYMOUS and the
   governance routes are open). Never remove auth to make a check pass.
5. Generate KOHAKU_CAPABILITY_SECRET with openssl rand -base64 32; keep it in the environment,
   never commit it, never hard-code a fallback.

STEPS
1. DomainPort: fill kohaku/ports.ts to wrap the server's EXISTING data access (reuse, don't copy).
2. Intent: one defineIntent per tool in kohaku/intents.ts (canonical name, Zod params,
   queries). Its `source` must equal createKohakuHost's querySource.
3. Host: const host = createKohakuHost({ domain, querySource, llm: createLlmFromEnv(),
   intents: intents.map((i) => i.toIntentDef()), dataVersion, policy: { fixedSpecs } }).
   fixedSpecs (FixedSpecSource, @kohaku-ui/composer) gives the main Intent an L0 Spec: no
   model, no key. Other Intents reach L1, which needs KOHAKU_LLM_PROVIDER and its key in .env.
4. MCP: attachKohakuMcp(server, host, { rendererHtml: loadRendererHtml, intentTools:
   intentToolsFromCatalog(intents.map((i) => i.toToolSource())) }), attachKohakuMcp from
   @kohaku-ui/host/mcp, loadRendererHtml from @kohaku-ui/mcp-renderer; then connect a
   StdioServerTransport (@modelcontextprotocol/server/stdio).
5. Register it (Claude Code: claude mcp add --env KOHAKU_CAPABILITY_SECRET=<secret> <name> --
   npx tsx ./server.ts); each Intent becomes a tool, dots become underscores.

DONE WHEN
- with host.app served on 127.0.0.1 by @hono/node-server, npx @kohaku-ui/cli conformance --rest
  http://127.0.0.1:<port>/api/kohaku --intent '{"canonical":"<your L0 Intent>","params":{}}'
  reports CONFORMANT;
- the registered tool returns a Spec plus a text summary, and the project's tests pass.
