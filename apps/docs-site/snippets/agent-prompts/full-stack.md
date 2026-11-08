You are adding kohaku (https://github.com/yosuque/kohaku) to an existing web backend.
Work in small steps and run the project's own tests after each one.

GOAL
Let a model compose screens from a governed catalog (L1), with fixed screens (L0), a review
loop for model-invented parts (promotion) and an audit trail (lineage), behind a REST host.

INSTALL
npm i @kohaku-ui/host @kohaku-ui/host-rest @kohaku-ui/lineage @kohaku-ui/storage-memory @kohaku-ui/llm @kohaku-ui/composer @kohaku-ui/intents @kohaku-ui/spec-core hono @hono/node-server @ai-sdk/anthropic zod
npx @kohaku-ui/cli scaffold ports --out ./kohaku   # writes ports.ts, intents.ts, server.ts

RULES
1. Never put row data in a Spec or a prompt. Specs carry query:// references only.
2. Every write is a DomainPort operation declared in listOperations() with a paramsSchema
   and a tier ("auto" | "confirm" | "approve"). Never mutate inside a read operation.
3. Tests never call a real LLM: use FakeLlm from @kohaku-ui/llm/fake.

STEPS
1. DomainPort (kohaku/ports.ts) wraps the backend's EXISTING data access; one defineIntent
   per screen in kohaku/intents.ts, with `source` equal to createKohakuHost's querySource.
2. L0: write kohaku/fixed-specs.ts, a FixedSpecSource (@kohaku-ui/composer) whose lookup(intent)
   returns a Spec builder, or null for an Intent that should reach the model.
3. Create storage = createMemoryStoragePort() and lineage = createLineage({ storage }) first,
   then createKohakuHost({ domain, storage, querySource, llm: createLlmFromEnv(), intents,
   dataVersion, policy: { fixedSpecs, allowL2: true }, recorder: createViewRecorder(lineage),
   routes: { ... } }).
4. Governance, inside routes: auth (resolve the principal from the project's own identity
   provider, not a client header), authorizeGovernance: createGovernancePolicy({ roles }),
   promotions: createPromotions({ lineage, storage }), fixations: createFixations({ lineage,
   storage }), fixationLookup. Set KOHAKU_CAPABILITY_SECRET (dev: true is local only).
5. Serve host.app with @hono/node-server; routes mount at /api/kohaku.

DONE WHEN
- npx @kohaku-ui/cli conformance --rest http://localhost:<port>/api/kohaku reports CONFORMANT;
- POST /compose records events readable at GET /lineage, and a role without the permission
  gets 403 on POST /promotions/:id/approve;
- the project's tests, typecheck and lint pass.
