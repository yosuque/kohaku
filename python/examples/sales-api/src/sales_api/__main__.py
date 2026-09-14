"""Startup entry of the sample API (equivalent to apps/sample-api/src/index.ts).

Run: cd python && uv run python -m sales_api
Environment variables:
- PORT (default 8790; a separate port so it can coexist with the TS version sample-api's 8787)
- KOHAKU_LLM_PROVIDER: fake (default, the deterministic pseudo LLM) / claude / openai / gemini / ollama / llama
  (anything other than fake is delegated to kohaku.llm's create_llm_from_env — see KOHAKU_LLM_*; the native
  claude / gemini adapters require the optional extras `kohaku-ui[claude]` / `kohaku-ui[gemini]`)
- KOHAKU_CAPABILITY_SECRET (default dev-secret-change-me)
- KOHAKU_DATA_DIR (default python/examples/sales-api/.data)
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from kohaku.llm import LlmPort, create_llm_from_env
from kohaku.storage import FileStoragePort

from .app import create_app
from .authz_port import create_hmac_authz_port
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
    authz = create_hmac_authz_port(
        os.environ.get("KOHAKU_CAPABILITY_SECRET", "dev-secret-change-me")
    )
    # create_app is async because it performs startup reconcile (snapshot authority -> projection). The app is
    # assembled in a separate event loop before uvicorn.run (reconcile is only storage read/write and independent of uvicorn).
    sales = asyncio.run(create_app(llm=llm, storage=storage, authz=authz))

    port = int(os.environ.get("PORT", "8790"))
    print(f"kohaku sample sales-api (Python): http://localhost:{port}")
    print(f"  LLM: {llm.provider} / {llm.model_id}")
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
