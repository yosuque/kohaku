You are adding kohaku (https://github.com/yosuque/kohaku) to an existing FastAPI app.
Work in small steps and run the project's own tests after each one.

GOAL
Mount the kohaku REST profile on the app's FastAPI instance, so the frontend can ask for
UI Specs (GET/POST under /api/kohaku) over the app's EXISTING data access.

INSTALL
pip install "kohaku-ui[rest,llm]"      # imports as `kohaku`; add [claude] or [gemini] for those providers

RULES
1. Never put row data in a Spec. Specs carry query:// references; rows leave only through
   DomainPort.invoke, reached with a capability the host issues.
2. Every write is a DomainPort operation in list_operations() with a paramsSchema and a
   tier ("auto" | "confirm" | "approve"). Never mutate inside a read operation.
3. Tests never call a real LLM: use FakeLlm from kohaku.llm.

STEPS
1. DomainPort (kohaku.spec): list_operations() -> OperationDescriptor list, invoke(op, args,
   ctx) -> result. Wrap the app's existing data access; do not copy data.
2. The Python library has no one-call facade, so write the other Ports by hand, following
   python/examples/sales-api/src/sales_api/: authz_port.py (HmacAuthzPort, secret from
   KOHAKU_CAPABILITY_SECRET), semantic_port.py (SemanticPort: normalize, resolve_query) and
   intents_catalog.py (define_intent from kohaku.intents). Storage: kohaku.storage.FileStoragePort.
3. Compose context: ComposeContext(catalog=resolve_catalog(core_catalog()), semantic=...,
   storage=..., llm=create_llm_from_env()) with core_catalog/resolve_catalog from
   kohaku.registry, ComposeContext from kohaku.composer, create_llm_from_env from kohaku.llm.
4. Mount: attach_kohaku_routes(app, KohakuHostDeps(compose=..., domain=..., authz=...,
   query_source="<source>", auth=<resolve the principal from the app's own identity>,
   authorize_governance=create_governance_policy(...)), "/api/kohaku") with those names
   from kohaku.host_rest. query_source must equal the source of every Intent.
5. Keep the existing routes and middleware untouched; run with the app's usual uvicorn command.

DONE WHEN
- npx @kohaku-ui/cli conformance --rest http://localhost:<port>/api/kohaku reports CONFORMANT;
- POST /api/kohaku/compose with an Intent returns a Spec that holds no row values;
- the project's tests (pytest), mypy and ruff pass.
