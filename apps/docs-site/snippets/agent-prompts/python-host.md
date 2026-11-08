You are adding kohaku (https://github.com/yosuque/kohaku) to an existing FastAPI app. Work in
small steps and run the project's own tests after each one.

GOAL
Mount the kohaku REST profile on the app's FastAPI instance, so the frontend can ask for
UI Specs (GET/POST under /api/kohaku) over the app's EXISTING data access.

INSTALL
pip install "kohaku-ui[rest,llm]"      # imports as `kohaku`; add [claude] or [gemini] for those providers

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
1. DomainPort (kohaku.spec): list_operations() and invoke(op, args, ctx) wrap EXISTING data access.
2. The Python library has no one-call facade, so write the other Ports by hand, following
   https://github.com/yosuque/kohaku/tree/main/python/examples/sales-api/src/sales_api/ :
   __main__.py (kohaku.authz_hmac.create_hmac_authz_port(secret): fail when the secret is unset,
   do not copy its dev fallback), semantic_port.py (SemanticPort: normalize, resolve_query), intents_catalog.py
   (define_intent from kohaku.intents), fixed_specs.py (L0 Specs: no model, no key).
   Storage: kohaku.storage.FileStoragePort.
3. Compose context: ComposeContext(catalog=resolve_catalog(core_catalog()), semantic=...,
   storage=..., llm=create_llm_from_env()); core_catalog/resolve_catalog are in
   kohaku.registry, ComposeContext in kohaku.composer, create_llm_from_env in kohaku.llm.
4. Mount: attach_kohaku_routes(app, KohakuHostDeps(compose=..., domain=..., authz=...,
   query_source="<source>", auth=<resolve the principal from the app's own identity>,
   authorize_governance=create_governance_policy(...)), "/api/kohaku") with those names
   from kohaku.host_rest. query_source must equal the source of every Intent. Leave existing
   routes untouched; run with the app's usual uvicorn command.

DONE WHEN
- npx @kohaku-ui/cli conformance --rest http://localhost:<port>/api/kohaku
  --intent '{"canonical":"<an L0 Intent of yours>","params":{}}' reports CONFORMANT (the CLI
  sends no credentials: use a dev instance whose auth resolves a fixed dev principal);
- POST /api/kohaku/compose with an Intent returns a Spec that holds no row values;
- the project's tests (pytest), mypy and ruff pass.
