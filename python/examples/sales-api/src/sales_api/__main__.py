"""Startup entry of the sample API (equivalent to apps/sample-api/src/index.ts).

Run: cd python && uv run python -m sales_api
Environment variables:
- PORT (default 8790; a separate port so it can coexist with the TS version sample-api's 8787)
- KOHAKU_LLM_PROVIDER: fake (default, the deterministic pseudo LLM) / claude / openai / gemini / ollama / llama
  (anything other than fake is delegated to kohaku.llm's create_llm_from_env — see KOHAKU_LLM_*; the native
  claude / gemini adapters require the optional extras `kohaku-ui[claude]` / `kohaku-ui[gemini]`)
- KOHAKU_CAPABILITY_SECRET (default dev-secret-change-me; `jwt` refuses to run on the default)
- KOHAKU_DATA_DIR (default python/examples/sales-api/.data)
- KOHAKU_AUTHZ: hmac (default; the x-kohaku-role / x-kohaku-tenant demo header identity) / jwt (principal, roles
  and tenant come from a verified bearer JWT; needs the `kohaku-ui[jwt]` extra). Under jwt:
  KOHAKU_JWT_SECRET (an HS256 shared secret, at least 32 bytes) or KOHAKU_JWT_JWKS_URL (with KOHAKU_JWT_AUDIENCE),
  and optionally KOHAKU_JWT_AUDIENCE / KOHAKU_JWT_ISSUER; KOHAKU_JWT_REQUIRE_TENANT=0 accepts tokens with no tenant
  claim (default: reject them, and require every capability to bind the tenant)
- KOHAKU_DEMO_ADMIN_ROUTES=1: registers the demo bump-data-version route under jwt (always on under hmac)
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from kohaku.authz_hmac import (
    create_hmac_approval_port,
    create_memory_approval_store,
)
from kohaku.llm import LlmPort, create_llm_from_env
from kohaku.storage import FileStoragePort

from .app import create_app
from .authz_from_env import create_authz_from_env
from .fake_llm import create_deterministic_fake_llm


def _create_llm() -> LlmPort:
    provider = os.environ.get("KOHAKU_LLM_PROVIDER", "fake")
    if provider == "fake":
        # The deterministic pseudo LLM (for demos / conformance). To use a real LLM, set KOHAKU_LLM_PROVIDER.
        return create_deterministic_fake_llm()
    return create_llm_from_env()


def main() -> None:
    try:
        import uvicorn
    except ImportError as err:
        raise RuntimeError(
            "Starting the server requires uvicorn. Run `uv sync` (dev) or"
            " `pip install 'kohaku-ui[rest]'`."
        ) from err

    llm = _create_llm()
    data_dir = Path(os.environ.get("KOHAKU_DATA_DIR", Path(__file__).parents[2] / ".data"))
    storage = FileStoragePort(data_dir)
    # KOHAKU_AUTHZ selects the AuthzPort (hmac / jwt). This REST host issues every capability with the request's
    # resolved tenant, so under jwt it can also require the capability to bind one (SPEC CAP-TEN-001).
    authz_env = create_authz_from_env(os.environ, require_capability_tenant=True)
    capability_secret = authz_env.capability_secret
    authz = authz_env.authz
    identity = None
    if authz_env.identity is not None:
        from .request_identity_jwt import create_jwt_request_identity

        identity = create_jwt_request_identity(authz_env.identity)
    # Governed actions (design.md #62/#63): the demo's "approve"-tier action ("publish",
    # sales_api/app.py's SalesDomainPort) needs an ApprovalPort to ever be allowed. Reuses the same
    # KOHAKU_CAPABILITY_SECRET as the AuthzPort -- the approval MAC key is derived from it under its own
    # label, so the token domains stay separate and sharing the secret is by design, not a shortcut (see
    # kohaku.authz_hmac's approval_port module docstring). With an in-process ApprovalStore so an approval is single-use
    # (design.md #63; without one a token stays replayable until it expires).
    approvals = create_hmac_approval_port(capability_secret, store=create_memory_approval_store())
    # create_app is async because it performs startup reconcile (snapshot authority -> projection). The app is
    # assembled in a separate event loop before uvicorn.run (reconcile is only storage read/write and independent of uvicorn).
    # The demo bump-data-version route is on by default for the header-based demo identity and off by default
    # under jwt; KOHAKU_DEMO_ADMIN_ROUTES=1 opts back in (see create_app's `demo_admin_routes` docstring).
    demo_admin_routes = os.environ.get("KOHAKU_DEMO_ADMIN_ROUTES") == "1" or identity is None
    sales = asyncio.run(
        create_app(
            llm=llm,
            storage=storage,
            authz=authz,
            approvals=approvals,
            identity=identity,
            demo_admin_routes=demo_admin_routes,
        )
    )

    port = int(os.environ.get("PORT", "8790"))
    print(f"kohaku sample sales-api (Python): http://localhost:{port}")
    print(f"  LLM: {llm.provider} / {llm.model_id}")
    print(f"  authz: {authz_env.kind}")
    print(f"  seed: {len(sales.repo.records)} records ({sales.repo.data_version()})")
    # Graceful shutdown (ops; mirrors apps/sample-api/src/index.ts's KOHAKU_SHUTDOWN_GRACE_MS drain window):
    # uvicorn already stops accepting new connections and drains in-flight ones on SIGINT/SIGTERM on its own;
    # timeout_graceful_shutdown just bounds how long it waits before forcing worker/connection shutdown.
    uvicorn.run(
        sales.app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        timeout_graceful_shutdown=30,
    )


if __name__ == "__main__":
    main()
