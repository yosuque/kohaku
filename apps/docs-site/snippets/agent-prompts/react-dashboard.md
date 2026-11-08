You are adding kohaku (https://github.com/yosuque/kohaku) to an existing React app.
Work in small steps and run the app's own tests after each one.

GOAL
Replace the hand-built dashboard screen <PAGE, e.g. src/pages/Sales.tsx> with a kohaku
UI Spec: a kohaku host serves the screen as data, @kohaku-ui/renderer-react draws it.
Leave every other screen untouched.

INSTALL
npm i @kohaku-ui/renderer-react @kohaku-ui/renderer-core @kohaku-ui/spec-core @kohaku-ui/client @kohaku-ui/data-binding
npm i @kohaku-ui/host @kohaku-ui/intents @kohaku-ui/composer @kohaku-ui/llm hono @hono/node-server zod
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # writes ports.ts, intents.ts, server.ts

RULES
1. Never put row data in a Spec. Charts and tables carry query:// references; the client
   fetches rows with the capability the host issues for that Spec.
2. Every write is a DomainPort operation declared in listOperations() with a paramsSchema
   and a tier ("auto" | "confirm" | "approve"). Never mutate inside a read operation.
3. Tests never call a real LLM: use FakeLlm from @kohaku-ui/llm/fake.

STEPS
1. DomainPort: fill kohaku/ports.ts so listOperations/invoke wrap the app's EXISTING data
   access (reuse it, do not copy data).
2. Intent: in kohaku/intents.ts, one defineIntent per screen (canonical name, Zod params,
   queries -> query://<source>/<op>). Its `source` must equal createKohakuHost's querySource.
3. Host: createKohakuHost({ domain, querySource, llm: createLlmFromEnv(), intents:
   intents.map((i) => i.toIntentDef()), dataVersion, policy: { fixedSpecs }, dev: true }).
   fixedSpecs (FixedSpecSource, @kohaku-ui/composer) builds the L0 Spec, so no model is
   called. dev: true is local only; production sets KOHAKU_CAPABILITY_SECRET instead.
   Serve host.app with @hono/node-server; its routes mount at /api/kohaku.
4. Renderer: createKohakuClient({ baseUrl }).compose({ intent }) returns { spec, capability }.
   Render <SpecView spec={spec} /> inside <RendererProvider value={{ impls:
   createCoreRegistry(), binding: createBindingClient({ baseUrl, capability }),
   theme: defaultLightTheme }}>. createCoreRegistry is in @kohaku-ui/renderer-react/core.
5. Switch the old screen over; delete its dead code only after the new one renders.

DONE WHEN
- the screen shows the same numbers as before and the composed Spec holds no row values;
- npx @kohaku-ui/cli conformance --rest http://localhost:<port>/api/kohaku reports CONFORMANT;
- the app's tests, typecheck and lint pass.
