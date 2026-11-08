You are adding kohaku (https://github.com/yosuque/kohaku) to an existing React app. Work in
small steps and run the app's own tests after each one.

GOAL
Replace the hand-built dashboard screen <PAGE, e.g. src/pages/Sales.tsx> with a kohaku UI Spec:
a kohaku host serves it as data and @kohaku-ui/renderer-react draws it. Leave other screens alone.

INSTALL
npm i @kohaku-ui/renderer-react @kohaku-ui/renderer-core @kohaku-ui/spec-core @kohaku-ui/client @kohaku-ui/data-binding
npm i @kohaku-ui/host @kohaku-ui/intents @kohaku-ui/composer @kohaku-ui/llm hono @hono/node-server zod
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # writes ports.ts, intents.ts, server.ts

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
1. DomainPort: fill kohaku/ports.ts to wrap the app's EXISTING data access (reuse, don't copy).
2. Intent: in kohaku/intents.ts, one defineIntent per screen (canonical name, Zod params,
   queries -> query://<source>/<op>). Its `source` must equal createKohakuHost's querySource.
3. Host: createKohakuHost({ domain, querySource, llm: createLlmFromEnv(), intents:
   intents.map((i) => i.toIntentDef()), dataVersion, policy: { fixedSpecs }, dev: true,
   routes: { auth, authorizeGovernance } }). fixedSpecs (FixedSpecSource, @kohaku-ui/composer)
   builds the L0 Spec: no model, no key. Serve host.app with @hono/node-server (routes mount
   at /api/kohaku) and let the dev server reach it (a Vite proxy for /api, or CORS).
4. Renderer: createKohakuClient({ baseUrl }).compose({ intent }) returns { spec, capability }.
   Render <SpecView spec={spec} /> inside <RendererProvider value={{ impls:
   createCoreRegistry(), binding: createBindingClient({ baseUrl, capability }),
   theme: defaultLightTheme }}>. createCoreRegistry is in @kohaku-ui/renderer-react/core.
5. Switch the old screen over; delete its dead code only once the new one renders.

DONE WHEN
- the screen shows the same numbers as before and the composed Spec holds no row values;
- npx @kohaku-ui/cli conformance --rest http://localhost:<port>/api/kohaku --intent
  '{"canonical":"<an L0 Intent of yours>","params":{}}' reports CONFORMANT (the CLI sends no
  credentials: use a dev instance whose auth resolves a fixed dev principal);
- the app's tests, typecheck and lint pass.
