"""MCP server for external chat clients (Streamable HTTP. TS: the Python version of apps/sample-mcp/src/http.ts).

claude.ai / ChatGPT can only connect through remote MCP connectors (Streamable HTTP), so in addition to stdio
(mcp_main.py) this HTTP entry point is provided. The common setup (Ports, .data, catalog) is shared with
mcp_setup.py. The transport puts the MCP Python SDK's StreamableHTTPSessionManager on uvicorn/starlette (the SDK
handles session management, idle cleanup, and optional DNS rebinding protection).

⚠️ No authentication (demo). This HTTP entry has no authentication whatsoever. It assumes local use
   (127.0.0.1:8791); when connecting claude.ai / ChatGPT through a public tunnel (ngrok / cloudflared, etc.),
   anyone who knows the URL can view and operate the sales data. Share only with trusted parties and do not put
   sensitive data on it.

Usage:
  cd python && uv run python -m sales_api.mcp_http           # listen on :8791 (/mcp)
  KOHAKU_MCP_HTTP_PORT=9000 uv run python -m sales_api.mcp_http
env:
- KOHAKU_MCP_HTTP_PORT (default 8791; a separate port so it can coexist with the TS version's :8788)
- KOHAKU_MCP_HTTP_HOST (default 127.0.0.1 = local only. For LAN / container exposure, override explicitly with 0.0.0.0)
- KOHAKU_MCP_PUBLIC_URL (the base URL for snapshot publishing. The tunnel URL when using a public tunnel)
- KOHAKU_MCP_HTTP_ALLOWED_HOSTS (comma-separated. Enables DNS rebinding protection only when specified)
For UI display, run `pnpm --filter @kohaku-ui-sample/mcp build:renderer` beforehand.
"""

from __future__ import annotations

import contextlib
import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from .mcp_setup import KohakuMcpSetup, create_kohaku_mcp_setup

_MCP_PATH = "/mcp"
_SNAPSHOT_PREFIX = "/snapshots"


def parse_allowed_hosts(value: str | None) -> list[str]:
    """Parses the comma-separated allowed-hosts env (empty -> empty = protection off). Exported for testability."""
    if not value:
        return []
    return [h.strip() for h in value.split(",") if h.strip() != ""]


def _serve_snapshot_body(snapshot_dir: Path, raw_name: str) -> tuple[int, str, bytes]:
    """A pure function that reads out the snapshot HTML (status, content_type, body). Separated for testability.

    Path traversal is prevented in layers: (1) reject names containing path separators, parent references, or NUL,
    (2) confirm the resolved destination stays under snapshot_dir. Unauthenticated (anyone who knows this URL can view it; demo policy).
    """
    name = raw_name
    if (
        name == ""
        or "/" in name
        or "\\" in name
        or ".." in name
        or "\0" in name
    ):
        return 400, "text/plain; charset=utf-8", b"Invalid file name"
    base = snapshot_dir.resolve()
    full = (base / name).resolve()
    if full != base and base not in full.parents:
        return 400, "text/plain; charset=utf-8", b"Invalid file name"
    try:
        body = full.read_bytes()
    except OSError:
        return 404, "text/plain; charset=utf-8", b"Snapshot not found"
    return 200, "text/html; charset=utf-8", body


def build_starlette_app(setup: KohakuMcpSetup, *, allowed_hosts: list[str] | None = None) -> Any:
    """Assembles a Starlette app from setup (passed to uvicorn). Does not listen (the caller decides the port).

    Returns a Starlette app (ASGI callable). To keep the design of not top-level importing starlette in the module,
    it returns Any (uvicorn.run accepts it as an ASGI callable).
    """
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
    from mcp.server.transport_security import TransportSecuritySettings
    from starlette.applications import Starlette
    from starlette.middleware import Middleware
    from starlette.middleware.cors import CORSMiddleware
    from starlette.requests import Request
    from starlette.responses import Response
    from starlette.routing import Mount, Route

    # Pass a single Server to the SDK's stateful session management (shared across all sessions. TS is per-session,
    # but the Python SDK's convention is sharing a single Server). Idle cleanup is handled by the SDK via session_idle_timeout.
    # Production hook: because this one Server is shared by every session, mcp_setup.py's McpHostDeps leaves
    # resolve_principal unwired here (every call runs as the anonymous principal) — a real deployment MUST wire
    # it (McpHostDeps.resolve_principal, resolved per tool call from that call's mcp SDK RequestContext) rather
    # than a single static McpHostDeps.principal, which would give every caller the same identity.
    server = setup.create_server()
    security_settings = (
        TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=allowed_hosts)
        if allowed_hosts
        else None
    )
    # Unlike the TS entry (http.ts's explicit 4 MiB MAX_BODY_BYTES), request body size limiting is delegated to
    # the SDK / uvicorn stack here (acceptable for the localhost demo; put a limiting reverse proxy in front
    # when exposing beyond localhost).
    session_manager = StreamableHTTPSessionManager(
        app=server,
        json_response=False,
        stateless=False,
        security_settings=security_settings,
        session_idle_timeout=1800.0,  # clean up after 30 min idle (equivalent to TS's TTL sweep).
    )

    async def handle_mcp(scope: object, receive: object, send: object) -> None:
        await session_manager.handle_request(scope, receive, send)  # type: ignore[arg-type]

    async def serve_snapshot(request: Request) -> Response:
        # Static snapshot serving (so it can be opened by URL even in remote MCP). Accepts only a single segment.
        status, content_type, body = _serve_snapshot_body(
            setup.snapshot_dir, request.path_params.get("file_name", "")
        )
        return Response(content=body, status_code=status, media_type=content_type)

    @contextlib.asynccontextmanager
    async def lifespan(_app: Starlette) -> AsyncIterator[None]:
        async with session_manager.run():
            yield

    middleware = [
        Middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            # Explicitly allow custom headers from the browser and expose the session id.
            allow_headers=[
                "Content-Type",
                "Accept",
                "Authorization",
                "mcp-session-id",
                "mcp-protocol-version",
                "Last-Event-ID",
            ],
            expose_headers=["mcp-session-id"],
            max_age=86400,
        )
    ]
    return Starlette(
        routes=[
            Route(f"{_SNAPSHOT_PREFIX}/{{file_name}}", serve_snapshot, methods=["GET"]),
            Mount(_MCP_PATH, app=handle_mcp),
        ],
        middleware=middleware,
        lifespan=lifespan,
    )


def main() -> None:
    try:
        import uvicorn
    except ImportError as err:
        raise RuntimeError(
            "Starting the MCP HTTP server requires uvicorn / starlette. Run `uv sync` (dev) or"
            " `pip install 'kohaku-ui[rest,mcp]'`."
        ) from err

    port = int(os.environ.get("KOHAKU_MCP_HTTP_PORT", "8791"))
    host = os.environ.get("KOHAKU_MCP_HTTP_HOST", "127.0.0.1")
    # The base URL for snapshot publishing. When using a public tunnel, set the tunnel's URL.
    # If unspecified, falls back to localhost (local viewing only). The trailing slash is stripped.
    public_url = (os.environ.get("KOHAKU_MCP_PUBLIC_URL") or f"http://localhost:{port}").rstrip("/")
    allowed_hosts = parse_allowed_hosts(os.environ.get("KOHAKU_MCP_HTTP_ALLOWED_HOSTS"))

    import asyncio

    setup = asyncio.run(create_kohaku_mcp_setup(snapshot_base_url=public_url))
    app = build_starlette_app(setup, allowed_hosts=allowed_hosts)

    print(
        f"kohaku-sales-sample MCP server: ready (Streamable HTTP) at http://{host}:{port}{_MCP_PATH}",
        file=sys.stderr,
    )
    print(f"  LLM: {setup.llm.provider} / {setup.llm.model_id}", file=sys.stderr)
    print(
        f"  Snapshot serving: {public_url}{_SNAPSHOT_PREFIX}/<file>"
        " (kohaku_render_snapshot returns this URL)",
        file=sys.stderr,
    )
    print(
        f"  bind: {host}:{port} (default 127.0.0.1 = local only. For LAN / container exposure,"
        " override explicitly with KOHAKU_MCP_HTTP_HOST=0.0.0.0)",
        file=sys.stderr,
    )
    print(
        "  ⚠️ No authentication (demo). Anyone who knows the URL can view and operate the sales data.",
        file=sys.stderr,
    )
    if allowed_hosts:
        print(f"  DNS rebinding protection: enabled (allowed_hosts={', '.join(allowed_hosts)})", file=sys.stderr)
    else:
        print(
            "  DNS rebinding protection: disabled (enable by listing allowed hosts in KOHAKU_MCP_HTTP_ALLOWED_HOSTS)",
            file=sys.stderr,
        )

    uvicorn.run(app, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
