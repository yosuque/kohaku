"""Common setup for sample-mcp (used by both stdio and Streamable HTTP. TS: apps/sample-mcp/src/setup.ts).

It assembles env loading, create_app (Ports + Composition Service), the View Lineage recorder, and the renderer /
snapshot wiring once, and returns a factory (create_server) that "creates an attached MCP Server".

- stdio (mcp_main.py) calls create_server() once and connects it to the stdio transport.
- Streamable HTTP (mcp_http.py) passes a single Server to StreamableHTTPSessionManager (the SDK's convention).
  The result of create_app (Ports, .data, catalog) is shared across all sessions.
"""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote

from kohaku.composer import ComposeTrace
from kohaku.host_mcp import (
    ActionEffects as McpActionEffects,
)
from kohaku.host_mcp import (
    AttachOptions,
    McpFixationsApi,
    McpHostDeps,
    attach_kohaku_to_mcp_server,
)
from kohaku.host_mcp.intent_tools import intent_tools_from_catalog
from kohaku.intents import IntentToolSource
from kohaku.lineage import create_view_recorder
from kohaku.llm import LlmPort
from kohaku.spec import FixationRecord, JsonObject, SessionContext, UISpec
from kohaku.storage import FileStoragePort

from .action_effects import sales_action_effects
from .app import admit_fixation_for_locale, create_app
from .authz_port import create_hmac_authz_port

_REPO_ROOT = Path(__file__).resolve().parents[5]
_RENDERER_PATH = _REPO_ROOT / "apps/sample-mcp/dist/renderer/index.html"

# Default directory for persistence shared with the Web app (shares promotion / fixation).
_DEFAULT_DATA_DIR = _REPO_ROOT / "apps/sample-api/.data"

_FALLBACK_HTML = (
    "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
    "<title>kohaku renderer not built</title></head>"
    "<body style='font-family:sans-serif;padding:24px;color:#475569'>"
    "The shared renderer has not been built. Run "
    "<code>pnpm --filter @kohaku-ui-sample/mcp build:renderer</code>."
    "</body></html>"
)


def make_snapshot_locator(*, snapshot_base_url: str | None, snapshot_dir: Path, file_name: str) -> str:
    """A pure function that decides the snapshot locator (the string returned to the model) (port of TS makeSnapshotLocator).

    - If snapshot_base_url is present, a public URL (`${base}/snapshots/${quote(file_name)}`).
      In remote MCP (Streamable HTTP), mcp_http serves /snapshots statically, so it can be opened by URL.
    - Otherwise the legacy local path (`snapshot_dir / file_name`). The stdio path uses this (behavior unchanged).
    """
    if snapshot_base_url is not None and snapshot_base_url != "":
        return f"{snapshot_base_url}/snapshots/{quote(file_name, safe='')}"
    return str(snapshot_dir / file_name)


def make_renderer_html_loader(
    *, path: Path = _RENDERER_PATH, fallback: str = _FALLBACK_HTML
) -> Callable[[], Awaitable[str]]:
    """The renderer HTML loader. Memoizes only successful reads. On file absence it just returns the fallback
    and does not cache (so that if build:renderer runs after MCP starts, the next call picks it up).
    """
    cache: dict[str, str] = {}

    async def load() -> str:
        if "html" in cache:
            return cache["html"]
        if not path.exists():
            return fallback  # absence is not cached (picks it up if built later)
        html = path.read_text(encoding="utf-8")
        cache["html"] = html
        return html

    return load


@dataclass(frozen=True)
class KohakuMcpSetup:
    """The result of the common setup. Shared by the stdio / HTTP entries."""

    create_server: Callable[[], Any]
    """Creates one attached MCP Server. The result of create_app, the catalog, and the recorder are shared."""
    llm: LlmPort
    data_dir: Path
    snapshot_dir: Path
    """The save directory of snapshot HTML (single source of truth). mcp_http uses it as the origin of /snapshots static serving."""


async def create_kohaku_mcp_setup(
    *,
    llm: LlmPort | None = None,
    data_dir: Path | None = None,
    snapshot_base_url: str | None = None,
) -> KohakuMcpSetup:
    """Runs the common setup once and returns a per-session Server factory.

    create_app is async because it performs startup reconcile (snapshot authority -> projection).

    - When llm is unspecified, it is built from env (KOHAKU_LLM_PROVIDER) (the default is the deterministic pseudo LLM).
    - Specifying snapshot_base_url makes kohaku_render_snapshot return a public URL (for remote MCP).
    """
    # Lazy import: the mcp SDK is the "mcp" extra. Matches host_mcp's design of not top-level importing mcp.
    from mcp.server.lowlevel import Server

    if llm is None:
        # Lazy import to borrow __main__'s _create_llm (fake/openai/ollama switching) (single source of truth).
        from .__main__ import _create_llm

        llm = _create_llm()
    resolved_data_dir = data_dir if data_dir is not None else _DEFAULT_DATA_DIR
    storage = FileStoragePort(resolved_data_dir)
    authz = create_hmac_authz_port(
        os.environ.get("KOHAKU_CAPABILITY_SECRET", "dev-secret-change-me")
    )

    sales = await create_app(llm=llm, storage=storage, authz=authz)
    # The MCP side's compose is also recorded to View Lineage (the same recorder as the REST side is built from the shared lineage).
    # This way, usage from MCP also remains as view.composed and merges into the promotion (minUses) / fixation counters.
    recorder = create_view_recorder(sales.lineage)

    # The save destination of the self-contained snapshot HTML (under the same .data as the Web app; gitignored).
    snapshot_dir = resolved_data_dir / "snapshots"

    # Fix the Intent catalog (core + what merged in from promotions at startup) once (statically at startup).
    # Promoted Intents are IntentDef (without to_tool_source), so IntentToolSource is constructed explicitly.
    intent_tools = intent_tools_from_catalog(
        [
            IntentToolSource(name=d.name, description=d.description, params=d.params)
            for d in sales.intent_catalog.list_defs()
        ]
    )

    load_renderer_html = make_renderer_html_loader()
    legacy_ui_resource = os.environ.get("KOHAKU_MCP_LEGACY_UI") == "1"

    async def fixation_lookup(
        intent_hash: str, session: SessionContext
    ) -> FixationRecord | None:
        # A plain read: delivery gating (the demo's EN-only language policy) is separated out into
        # admit_fixation_for_locale below, shared verbatim with the REST side's wiring in app.py, so this
        # stays a plain read (kohaku.host_core.FixationDeliveryHost.admit is what actually applies the
        # gate). Single-tenant operation (surface="mcp-app" / no tenant), so tenant is not passed (default
        # None).
        return await storage.get_fixation(intent_hash)

    async def on_composed(spec: UISpec, trace: ComposeTrace) -> None:
        # Record to View Lineage on each compose (surface is "mcp-app", representing the MCP Apps profile).
        await recorder.composed(spec=spec, trace=trace, surface="mcp-app")

    async def action_effects(action: str, payload: JsonObject, result: object) -> McpActionEffects:
        # Side-effect declaration for writes (kohaku_action). Shares the same sales_action_effects as the REST side (app.py),
        # making annotate's data-version advance -> invalidation of the displayed reference work symmetrically on the MCP side.
        effect = await sales_action_effects(action, payload, result)
        return McpActionEffects(invalidates=effect.invalidates, refVersions=effect.refVersions)

    async def snapshot_writer(file_name: str, html: str) -> str:
        # Writing always goes to local, and the locator returned to the model (public URL or local path) is decided by
        # make_snapshot_locator (a pure function) based on whether snapshot_base_url is present.
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        (snapshot_dir / file_name).write_text(html, encoding="utf-8")
        return make_snapshot_locator(
            snapshot_base_url=snapshot_base_url, snapshot_dir=snapshot_dir, file_name=file_name
        )

    def create_server() -> Any:
        server = Server("kohaku-sales-py")
        attach_kohaku_to_mcp_server(
            server,
            McpHostDeps(
                compose=sales.compose_ctx,
                domain=sales.domain,
                authz=authz,
                query_source="sales",
                # Fixation short-circuit (query before compose) + the self-healing entry for staleness detection.
                fixation_lookup=fixation_lookup,
                fixation_admit=admit_fixation_for_locale,
                # McpFixationsApi is now an alias of kohaku.host_core.FixationSelfHealApi (the same Protocol the
                # REST surface's FixationsApi aliases), which Fixations conforms to structurally as-is. The cast
                # is kept only because sales.fixations' declared type is the lineage-package concrete class, not
                # the Protocol, and mypy does not infer structural conformance through an attribute access.
                fixations=cast(McpFixationsApi, sales.fixations),
                # View Lineage recording on each compose (surface="mcp-app").
                on_composed=on_composed,
                # Side-effect declaration for writes (annotate). Shared with the REST side (not duplicated).
                action_effects=action_effects,
            ),
            AttachOptions(
                renderer_html=load_renderer_html,
                intent_tools=intent_tools,
                snapshot_writer=snapshot_writer,
                # Co-emit a UIResource for mcp-ui legacy-host compatibility. Off by default. Opt in via env only
                # when connecting to a legacy host (LibreChat, etc.) that does not support SEP-1865.
                legacy_ui_resource=legacy_ui_resource,
            ),
        )
        return server

    return KohakuMcpSetup(
        create_server=create_server,
        llm=llm,
        data_dir=resolved_data_dir,
        snapshot_dir=snapshot_dir,
    )


__all__ = [
    "KohakuMcpSetup",
    "create_kohaku_mcp_setup",
    "make_renderer_html_loader",
    "make_snapshot_locator",
]
