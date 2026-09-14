"""Public API attach_kohaku_routes (equivalent to createKohakuRoutes in packages/host-rest/src/routes.ts).

fastapi is a "rest" extra. The route implementation body (_fastapi_routes) imports fastapi / starlette at
the top level, so it is **lazily loaded** from this module (which does not require fastapi at import time).
When absent, a RuntimeError prompts `pip install 'kohaku-ui[rest]'`.

The wire shape (endpoint paths, status codes, error envelope {error:{code,message,requestId?}}, SSE format)
matches the TS reference implementation. The SSE keepalive heartbeat (emits a `: keepalive` comment line at
15s intervals during generation; constant SSE_HEARTBEAT_INTERVAL_S) also matches TS (SSE_HEARTBEAT_INTERVAL_MS=15000).

Intentional differences (with rationale):
- The governance service surface (Promotions / Fixations / ViewRecorder / summarizer) is received via structural
  Protocols (the same loose coupling as TS). However, the promotion action value types (Nominate, etc.) and
  ComponentDraft are imported from kohaku.lineage because Python's state machine branches on isinstance (see bodies.py).
- Client-disconnect abort propagation is wired. starlette has no synthesis-free signal equivalent to Hono's
  c.req.raw.signal, so request.is_disconnected() is polled about every 250ms and converted into an AbortSignal,
  threaded through the generation of /compose, /compose/stream, and /events (riding the single-flight abort quorum
  — a lone request falls back immediately, and healthy followers are not affected).
- Fixation self-healing (refresh_fingerprint / invalidate) is awaited inline rather than fire-and-forget (to avoid
  background-task lifetime issues under ASGI / TestClient). Failures are reported to on_error and the response is
  still returned as a success (preserving the same "do not stop delivery" property as TS).
- The Promotions / Fixations Protocols require the reference implementation's full method surface (a difference from
  TS's optional methods). The 501 for the unwired case (deps.promotions / deps.fixations is None) is preserved.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .deps import KohakuHostDeps

if TYPE_CHECKING:
    from fastapi import FastAPI


def attach_kohaku_routes(
    app: FastAPI, deps: KohakuHostDeps, prefix: str = "/api/kohaku"
) -> FastAPI:
    """Attach the Kohaku Protocol REST profile routes to a FastAPI app under the given prefix.

    Usage::

        from fastapi import FastAPI
        app = FastAPI()
        attach_kohaku_routes(app, deps, "/api/kohaku")
    """
    try:
        from ._fastapi_routes import register_routes
    except ImportError as e:  # pragma: no cover - guidance when the dependency is not installed
        raise RuntimeError(
            "The REST host requires fastapi. Please run `pip install 'kohaku-ui[rest]'`."
        ) from e
    return register_routes(app, deps, prefix)
