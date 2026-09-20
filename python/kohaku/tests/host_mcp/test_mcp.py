"""Behavior tests for the MCP Apps profile (SEP-1865).

pytest-ification of TS packages/host-mcp-apps/test/mcp.test.ts. Explicitly checks MCPAPP-RES-001 / MCPAPP-FBK-001 /
MCPAPP-APP-001. In-process mcp client + FakeLlm (fixedSpecs path).
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from kohaku.host_mcp import (
    CAPABILITY_META_KEY,
    INITIAL_DATA_META_KEY,
    RENDERER_RESOURCE_URI,
    RESOURCE_MIME_TYPE,
    RESOURCE_URI_META_KEY,
    UI_META_KEY,
    VISIBILITY_META_KEY,
    ActionEffects,
    AttachOptions,
    McpErrorInfo,
    McpHostDeps,
    resource_ui_meta,
)
from kohaku.llm import FakeLlm
from kohaku.spec import Intent, OperationDescriptor, UISpec, parse_spec

from ._helpers import (
    BIND_REF_US,
    DATA,
    RENDERER_HTML_PLAIN,
    RENDERER_HTML_SNAPSHOT,
    TREND_REF,
    SimpleAuthz,
    TrendDomain,
    bind_spec_builder,
    connect,
    make_compose_ctx,
    make_no_fixed_compose_ctx,
    request_meta,
    write_spec_builder,
)


def _ui_meta(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    """Extract the modern (nested) _meta.ui."""
    if meta is None:
        return None
    return meta.get(UI_META_KEY)


def _capability_of(result: Any) -> str:
    """Extract the compose-issued capability token from a tool result's `_meta` (moved out of model-visible
    structuredContent — see server.py's _compose_and_package / meta.py's CAPABILITY_META_KEY)."""
    meta = result.meta
    assert meta is not None
    value = meta[CAPABILITY_META_KEY]
    assert isinstance(value, str)
    return value


def _deps(tmp_path: Path, **overrides: Any) -> McpHostDeps:
    base: dict[str, Any] = {
        "compose": make_compose_ctx(tmp_path),
        "domain": TrendDomain(),
        "authz": SimpleAuthz(),
        "query_source": "sales",
    }
    base.update(overrides)
    return McpHostDeps(**base)


_OPTIONS = AttachOptions(renderer_html=RENDERER_HTML_PLAIN)


class TestResourceAndDeclarations:
    def test_mcpapp_res_001_renderer_resource_mime(self, tmp_path: Path) -> None:
        """MCPAPP-RES-001: the ui:// resource is text/html;profile=mcp-app."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                resources = await client.list_resources()
                renderer = next(
                    (r for r in resources.resources if str(r.uri) == RENDERER_RESOURCE_URI), None
                )
                assert renderer is not None
                assert renderer.mime_type == RESOURCE_MIME_TYPE

                read = await client.read_resource(renderer.uri)
                assert read.contents[0].mime_type == RESOURCE_MIME_TYPE
                assert "renderer" in read.contents[0].text  # type: ignore[union-attr]

        asyncio.run(run())

    def test_resource_ui_meta_declares_empty_csp(self, tmp_path: Path) -> None:
        """The resource-side _meta.ui.csp is declared with an empty allowlist (wire-matches TS resourceUiMeta).

        It appears on both the resources/list resource and the contents of resources/read
        (SEP-1865 specifies contents-side precedence — declared identically on both).
        """
        expected: dict[str, Any] = {
            "ui": {
                "csp": {
                    "connectDomains": [],
                    "resourceDomains": [],
                    "frameDomains": [],
                    "baseUriDomains": [],
                }
            }
        }
        assert resource_ui_meta() == expected

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                resources = await client.list_resources()
                renderer = next(
                    (r for r in resources.resources if str(r.uri) == RENDERER_RESOURCE_URI), None
                )
                assert renderer is not None
                assert renderer.meta == expected

                read = await client.read_resource(renderer.uri)
                assert read.contents[0].meta == expected

        asyncio.run(run())

    def test_tool_declarations_visibility_and_resource_uri(self, tmp_path: Path) -> None:
        """compose is model-visible + resourceUri; binding/event are app-only (matching in both forms)."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                tools = (await client.list_tools()).tools
                by_name = {t.name: t for t in tools}

                compose_tool = by_name["kohaku_compose"]
                # legacy (flat) form
                assert compose_tool.meta is not None
                assert compose_tool.meta[RESOURCE_URI_META_KEY] == RENDERER_RESOURCE_URI
                assert compose_tool.meta[VISIBILITY_META_KEY] == ["model"]
                # modern (nested) form
                assert _ui_meta(compose_tool.meta) == {
                    "resourceUri": RENDERER_RESOURCE_URI,
                    "visibility": ["model"],
                }

                # MCPAPP-APP-001: binding/event are app-only.
                binding = by_name["kohaku_resolve_binding"]
                assert binding.meta is not None
                assert binding.meta[VISIBILITY_META_KEY] == ["app"]
                assert _ui_meta(binding.meta)["visibility"] == ["app"]  # type: ignore[index]
                # resolve_binding has no resourceUri (does not open a view).
                assert RESOURCE_URI_META_KEY not in binding.meta
                assert "resourceUri" not in (_ui_meta(binding.meta) or {})

                event_tool = by_name["kohaku_event"]
                assert event_tool.meta is not None
                assert event_tool.meta[VISIBILITY_META_KEY] == ["app"]
                assert _ui_meta(event_tool.meta) == {
                    "resourceUri": RENDERER_RESOURCE_URI,
                    "visibility": ["app"],
                }

        asyncio.run(run())

    def test_mcpapp_app_001_binding_event_action_are_app_only(self, tmp_path: Path) -> None:
        """MCPAPP-APP-001: the binding/event/action tools are ui/visibility=[app]."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                tools = (await client.list_tools()).tools
                by_name = {t.name: t for t in tools}
                for name in ["kohaku_resolve_binding", "kohaku_event", "kohaku_action"]:
                    meta = by_name[name].meta
                    assert meta is not None, name
                    assert meta[VISIBILITY_META_KEY] == ["app"], name
                    assert _ui_meta(meta)["visibility"] == ["app"]  # type: ignore[index]

        asyncio.run(run())


class TestComposeTool:
    def test_mcpapp_fbk_001_text_fallback_and_structured_spec(self, tmp_path: Path) -> None:
        """MCPAPP-FBK-001: the compose result has a non-empty text fallback + a structured Spec."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}
                )
                content = result.content[0]
                assert content.type == "text"
                assert "Monthly sales trend" in content.text
                assert len(content.text) > 20

                structured = result.structured_content
                assert structured is not None
                spec = parse_spec(structured["spec"])
                assert spec.provenance.tier == "L0"
                # The capability token rides _meta, not structuredContent (see CAPABILITY_META_KEY's doc
                # comment): a bearer write token must never enter the model's context.
                assert "capability" not in structured
                assert TREND_REF in _capability_of(result)
                # The tool result _meta also carries resourceUri in both forms.
                assert result.meta is not None
                assert result.meta[RESOURCE_URI_META_KEY] == RENDERER_RESOURCE_URI
                assert _ui_meta(result.meta)["resourceUri"] == RENDERER_RESOURCE_URI  # type: ignore[index]

        asyncio.run(run())

    def test_resolve_binding_requires_capability(self, tmp_path: Path) -> None:
        """app-only binding resolution: a capability is required and data flows only from the iframe."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                composed = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                capability = _capability_of(composed)

                ok = await client.call_tool(
                    "kohaku_resolve_binding", {"ref": TREND_REF, "capability": capability}
                )
                assert ok.structured_content is not None
                assert len(ok.structured_content["data"]["rows"]) == 2

                denied = await client.call_tool(
                    "kohaku_resolve_binding",
                    {"ref": "query://sales/records?limit=1", "capability": capability},
                )
                assert denied.is_error is True

        asyncio.run(run())


class TestResultType:
    """MCP 2026-07-28 (SEP-2322): every tool result carries resultType.

    pytest-ification of TS mcp.test.ts's "MCP 2026-07-28: every tool result carries resultType" describe
    block. This profile never produces an MRTR "input_required" interim result, so every result — success or
    isError — is "complete" (see _safe_tool's doc comment in server.py)."""

    def test_success_result_has_result_type_complete(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert not result.is_error
                assert result.result_type == "complete"

        asyncio.run(run())

    def test_error_result_also_has_result_type_complete(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_resolve_binding",
                    {"ref": "query://other/records", "capability": "cap:x"},
                )
                assert result.is_error
                assert result.result_type == "complete"

        asyncio.run(run())


class TestListResultCacheHints:
    """MCP 2026-07-28 (SEP-2549): tools/list, resources/list and (mcp 2.x closes a 1.x gap here — see
    _read_resource's doc comment in server.py) resources/read carry ttl_ms + cache_scope (CacheableResult).
    These fields are wire-real only on a 2026-07-28+ connection: `_call_tool`/`_list_tools`/etc. always
    construct the typed CacheableResult subclasses, but the mcp SDK's own result serializer sieves ttl_ms /
    cache_scope out of the wire dump for an older negotiated protocol version (its `serialize_server_result`
    validates against that version's own wire model), so a "legacy"-mode client — the default `connect()`
    mode this test module otherwise uses — would deserialize the defaults (`ttl_ms=0, cache_scope="private"`)
    instead of the values this profile sets. Connect at mode="2026-07-28" here to observe them for real."""

    def test_tools_list_has_ttl_and_cache_scope(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS, mode="2026-07-28") as client:
                result = await client.list_tools()
                assert result.ttl_ms == 60_000
                assert result.cache_scope == "private"

        asyncio.run(run())

    def test_resources_list_has_ttl_and_cache_scope(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS, mode="2026-07-28") as client:
                result = await client.list_resources()
                assert result.ttl_ms == 60_000
                assert result.cache_scope == "private"

        asyncio.run(run())

    def test_read_resource_has_ttl_and_cache_scope(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS, mode="2026-07-28") as client:
                resources = await client.list_resources()
                renderer = next(r for r in resources.resources if str(r.uri) == RENDERER_RESOURCE_URI)
                result = await client.read_resource(renderer.uri)
                assert result.ttl_ms == 60_000
                assert result.cache_scope == "private"

        asyncio.run(run())


class TestTraceparentCorrelation:
    """The failure-path observability hook's correlation id is always this call's own JSON-RPC request id --
    never derived from `_meta.traceparent`. A W3C trace-id is shared by an entire trace, so deriving the
    correlation id from it would give every tool call in one conversation the SAME id, making it impossible to
    tell which call a reported failure belongs to. See _correlation_id_from_request_context's doc comment in
    server.py. Trace correlation (linking a call's OTel span to the caller's own trace) flows separately,
    through trace_context -- see TestTraceContextPropagation below."""

    def test_two_calls_sharing_the_same_traceparent_get_different_correlation_ids(self, tmp_path: Path) -> None:
        async def run() -> None:
            seen: list[McpErrorInfo] = []

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(tmp_path, on_error=_on_error)
            trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
            traceparent = f"00-{trace_id}-00f067aa0ba902b7-01"
            async with connect(deps, _OPTIONS) as client:
                for _ in range(2):
                    # "other" is not a domain op TrendDomain knows (only "trend" is), so domain.invoke raises
                    # and _safe_tool's except branch fires (unlike an explicit _tool_error return, e.g. an
                    # unknown query source, which never reaches _report_mcp_error).
                    result = await client.call_tool(
                        "kohaku_resolve_binding",
                        {"ref": "query://sales/other", "capability": "cap:query://sales/other"},
                        meta=request_meta(traceparent=traceparent),
                    )
                    assert result.is_error
            assert len(seen) == 2
            assert seen[0].correlation_id is not None
            assert seen[1].correlation_id is not None
            # Same trace, two calls -> different correlation ids (never the shared trace-id).
            assert seen[0].correlation_id != seen[1].correlation_id
            assert seen[0].correlation_id != trace_id
            assert seen[1].correlation_id != trace_id
            # Both still carry the identical trace_context (the OTel-parenting signal), unaffected by
            # correlation_id.
            assert seen[0].trace_context is not None
            assert seen[0].trace_context == seen[1].trace_context
            assert seen[0].trace_context.traceparent == traceparent

        asyncio.run(run())

    def test_malformed_traceparent_still_yields_a_correlation_id_without_raising(self, tmp_path: Path) -> None:
        async def run() -> None:
            seen: list[McpErrorInfo] = []

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(tmp_path, on_error=_on_error)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_resolve_binding",
                    {"ref": "query://sales/other", "capability": "cap:query://sales/other"},
                    meta=request_meta(traceparent="not-a-real-traceparent"),
                )
                assert result.is_error
            assert len(seen) == 1
            # A malformed traceparent never affects correlation_id in the first place (it is always the
            # request id) -- fail-open, the call does not raise.
            assert seen[0].correlation_id is not None
            assert seen[0].correlation_id != "not-a-real-traceparent"

        asyncio.run(run())


class TestTraceContextPropagation:
    """MCP 2026-07-28 (SEP-414): `_meta.traceparent` (+ `_meta.tracestate`) also reaches the failure-path
    observability hook as a TraceContext (McpErrorInfo.trace_context), the same way it reaches
    correlation_id above -- see _trace_context_from_request_context's doc comment in server.py for the
    same parity-gap caveat (no ComposeOptions sink yet)."""

    def test_valid_traceparent_and_tracestate_reach_on_error(self, tmp_path: Path) -> None:
        async def run() -> None:
            seen: list[McpErrorInfo] = []

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(tmp_path, on_error=_on_error)
            traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_resolve_binding",
                    {"ref": "query://sales/other", "capability": "cap:query://sales/other"},
                    meta=request_meta(traceparent=traceparent, tracestate="vendor=value"),
                )
                assert result.is_error
            assert len(seen) == 1
            assert seen[0].trace_context is not None
            assert seen[0].trace_context.traceparent == traceparent
            assert seen[0].trace_context.tracestate == "vendor=value"

        asyncio.run(run())

    def test_malformed_traceparent_leaves_trace_context_none(self, tmp_path: Path) -> None:
        async def run() -> None:
            seen: list[McpErrorInfo] = []

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(tmp_path, on_error=_on_error)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_resolve_binding",
                    {"ref": "query://sales/other", "capability": "cap:query://sales/other"},
                    meta=request_meta(traceparent="not-a-real-traceparent"),
                )
                assert result.is_error
            assert len(seen) == 1
            assert seen[0].trace_context is None

        asyncio.run(run())


class TestAuditFailOpen:
    def test_on_composed_failure_is_fail_open(self, tmp_path: Path) -> None:
        """Even if on_composed throws, kohaku_compose returns a Spec and the error reaches the observation hook."""

        async def run() -> None:
            seen: list[McpErrorInfo] = []

            async def _on_composed(spec: Any, trace: Any) -> None:
                raise RuntimeError("onComposed recording failed (test)")

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(tmp_path, on_composed=_on_composed, on_error=_on_error)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                # Even if the audit record fails, the result is normal.
                assert not result.is_error
                assert parse_spec(result.structured_content["spec"]).provenance.tier == "L0"
                # The failure is reported to the observation hook (endpoint = compose).
                assert len(seen) == 1
                assert seen[0].endpoint == "compose"
                assert isinstance(seen[0].error, Exception)

        asyncio.run(run())


class TestRenderSnapshot:
    @staticmethod
    def _read_embedded(html: str) -> dict[str, Any]:
        open_tag = '<script id="kohaku-snapshot" type="application/json">'
        start = html.index(open_tag)
        frm = start + len(open_tag)
        end = html.index("</script>", frm)
        raw = html[frm:end]
        # If escaping works, no raw `<` (= the start of a closing tag) remains in the interval.
        assert "<" not in raw
        # `<` is a JSON escape, so json.loads restores it to `<` (no un-escaping needed).
        parsed: dict[str, Any] = json.loads(raw)
        return parsed

    def test_embeds_spec_and_data_and_returns_locator(self, tmp_path: Path) -> None:
        """Embeds spec and resolved data into the HTML and puts the locator in the tool result text."""

        async def run() -> None:
            written: list[tuple[str, str]] = []

            async def _writer(file_name: str, html: str) -> str:
                written.append((file_name, html))
                return f"/abs/snapshots/{file_name}"

            options = AttachOptions(
                renderer_html=RENDERER_HTML_SNAPSHOT, snapshot_writer=_writer
            )
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool(
                    "kohaku_render_snapshot", {"question": "Monthly sales trend"}
                )
                text = result.content[0].text  # type: ignore[union-attr]
                assert "/abs/snapshots/" in text
                assert "Snapshot:" in text
                structured = result.structured_content
                assert structured is not None
                assert "/abs/snapshots/" in structured["path"]
                assert parse_spec(structured["spec"]).provenance.tier == "L0"
                # The large HTML body is not included in the tool result.
                assert '<script id="kohaku-snapshot"' not in text

                assert len(written) == 1
                html = written[0][1]
                assert ">null</script>" not in html  # the placeholder is replaced
                embedded = self._read_embedded(html)
                assert embedded["spec"]["provenance"]["tier"] == "L0"
                assert len(embedded["data"][TREND_REF]["rows"]) == 2

        asyncio.run(run())

    def test_script_breakout_is_escaped(self, tmp_path: Path) -> None:
        """</script> in spec/data is escaped as \\u003c (breakout prevention)."""

        async def run() -> None:
            class XssDomain:
                async def list_operations(self) -> list[Any]:
                    return []

                async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                    from kohaku.spec import TabularData

                    return TabularData.model_validate(
                        {
                            "columns": [
                                {"key": "month", "type": "string"},
                                {"key": "revenue", "type": "number"},
                            ],
                            "rows": [
                                {"month": "</script><script>alert(1)</script>", "revenue": 1}
                            ],
                            "dataVersion": "sales@seed-1",
                        }
                    )

            written: list[str] = []

            async def _writer(file_name: str, html: str) -> str:
                written.append(html)
                return "/abs/snapshots/x.html"

            options = AttachOptions(
                renderer_html=RENDERER_HTML_SNAPSHOT, snapshot_writer=_writer
            )
            deps = _deps(tmp_path, domain=XssDomain())
            async with connect(deps, options) as client:
                await client.call_tool("kohaku_render_snapshot", {"question": "Monthly sales trend"})
                html = written[0]
                embedded = self._read_embedded(html)
                assert (
                    embedded["data"][TREND_REF]["rows"][0]["month"]
                    == "</script><script>alert(1)</script>"
                )
                # Only `<` is escaped (> is unchanged), so the escaped form becomes </script>.
                assert "\\u003c/script>" in html  # the escaped form is present in the body
                assert "</script><script>alert(1)" not in html  # the raw variant does not appear in the body

        asyncio.run(run())

    def test_snapshot_writer_unset_does_not_register_tool(self, tmp_path: Path) -> None:
        """If snapshot_writer is unwired, the tool itself is not registered."""

        async def run() -> None:
            options = AttachOptions(renderer_html=RENDERER_HTML_SNAPSHOT)
            async with connect(_deps(tmp_path), options) as client:
                tools = (await client.list_tools()).tools
                assert all(t.name != "kohaku_render_snapshot" for t in tools)

        asyncio.run(run())

    def test_missing_placeholder_reports_build_renderer(self, tmp_path: Path) -> None:
        """A renderer with no placeholder (unbuilt) fails while directing build:renderer."""

        async def run() -> None:
            async def _writer(file_name: str, html: str) -> str:
                return "/abs/snapshots/x.html"

            options = AttachOptions(
                renderer_html="<!DOCTYPE html><html><body>unbuilt</body></html>",
                snapshot_writer=_writer,
            )
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool(
                    "kohaku_render_snapshot", {"question": "Monthly sales trend"}
                )
                assert result.is_error is True
                assert "build:renderer" in result.content[0].text  # type: ignore[union-attr]

        asyncio.run(run())


class TestBindVariantCapability:
    def test_bind_variants_enumerated_and_resolvable(self, tmp_path: Path) -> None:
        """A1: fully enumerate data.bind's values cartesian product with a read scope, and the switched-to variant also resolves."""

        async def run() -> None:
            deps = _deps(tmp_path, compose=make_compose_ctx(tmp_path, builder=bind_spec_builder, ref=BIND_REF_US))
            async with connect(deps, _OPTIONS) as client:
                composed = await client.call_tool(
                    "kohaku_compose", {"question": "Trend with region switch"}
                )
                capability = _capability_of(composed)
                for region in ["us", "eu", "jp"]:
                    assert (
                        f"query://sales/trend?granularity=month&metric=revenue&region={region}"
                        in capability
                    )
                # Resolving the switched-to variant (eu) is not capability denied.
                resolved = await client.call_tool(
                    "kohaku_resolve_binding",
                    {
                        "ref": "query://sales/trend?granularity=month&metric=revenue&region=eu",
                        "capability": capability,
                    },
                )
                assert not resolved.is_error
                assert len(resolved.structured_content["data"]["rows"]) == 2

        asyncio.run(run())


class TestInitialDataMeta:
    def test_meta_key_matches_renderer_literal(self) -> None:
        """The meta-key constant matches the spec's literal string (detects drift with the renderer side)."""
        assert INITIAL_DATA_META_KEY == "kohaku/initialData"

    def test_initial_data_resolved_into_meta(self, tmp_path: Path) -> None:
        """The compose result's _meta co-embeds the preresolved initial data (resolved down to rows)."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert result.meta is not None
                initial = result.meta[INITIAL_DATA_META_KEY]
                assert len(initial[TREND_REF]["rows"]) == 2
                assert result.meta[RESOURCE_URI_META_KEY] == RENDERER_RESOURCE_URI

        asyncio.run(run())

    def test_budget_partial_prefers_initial_variant(self, tmp_path: Path) -> None:
        """When the budget is exceeded, it is partially embedded, prioritizing each component's initial variant ($ref)."""

        async def run() -> None:
            big_cell = "x" * 70_000

            class BigDomain:
                async def list_operations(self) -> list[Any]:
                    return []

                async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                    from kohaku.spec import TabularData

                    return TabularData.model_validate(
                        {
                            "columns": [{"key": "month", "type": "string"}],
                            "rows": [{"month": big_cell}],
                            "dataVersion": "sales@seed-1",
                        }
                    )

            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=bind_spec_builder, ref=BIND_REF_US),
                domain=BigDomain(),
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Trend with region switch"})
                assert result.meta is not None
                initial = result.meta[INITIAL_DATA_META_KEY]
                # Of the 3 variants, only the initial variant (us) fits the budget = partial embedding.
                assert list(initial.keys()) == [BIND_REF_US]

        asyncio.run(run())

    def test_per_ref_fail_open(self, tmp_path: Path) -> None:
        """per-ref fail-open: one ref's resolution failure is skipped and reported to on_error, and compose stays a success."""

        async def run() -> None:
            seen: list[McpErrorInfo] = []

            class FailEuDomain:
                async def list_operations(self) -> list[Any]:
                    return []

                async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                    if args.get("region") == "eu":
                        raise RuntimeError("eu resolution failed (test)")
                    return DATA

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=bind_spec_builder, ref=BIND_REF_US),
                domain=FailEuDomain(),
                on_error=_on_error,
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Trend with region switch"})
                assert not result.is_error
                assert result.meta is not None
                initial = result.meta[INITIAL_DATA_META_KEY]
                keys = list(initial.keys())
                assert BIND_REF_US in keys
                assert "query://sales/trend?granularity=month&metric=revenue&region=jp" in keys
                assert (
                    "query://sales/trend?granularity=month&metric=revenue&region=eu" not in keys
                )
                assert len(seen) == 1
                assert seen[0].endpoint == "compose.initialData"
                assert isinstance(seen[0].error, Exception)

        asyncio.run(run())

    def test_per_ref_timeout_skips_slow_ref(
        self, tmp_path: Path, monkeypatch: Any
    ) -> None:
        """per-ref timeout: even with a ref whose resolution never returns, the compose response returns and that ref is not co-embedded."""
        # PRERESOLVE_TIMEOUT_S is read (as a module global) by kohaku.host_mcp.initial_data's
        # _preresolve_initial_data / _resolve_ref_bounded, not by kohaku.host_mcp.server — patch it there
        # (patching kohaku.host_mcp.server.PRERESOLVE_TIMEOUT_S, an independent name binding created by that
        # module's own `from .initial_data import PRERESOLVE_TIMEOUT_S`, would silently not affect the value
        # those functions actually read).
        import kohaku.host_mcp.initial_data as initial_data_mod

        # Shrink the timeout to make the test fast (semantics unchanged: timeout = skip).
        monkeypatch.setattr(initial_data_mod, "PRERESOLVE_TIMEOUT_S", 0.05)
        eu_ref = "query://sales/trend?granularity=month&metric=revenue&region=eu"
        jp_ref = "query://sales/trend?granularity=month&metric=revenue&region=jp"

        async def run() -> None:
            seen: list[McpErrorInfo] = []

            class SlowEuDomain:
                async def list_operations(self) -> list[Any]:
                    return []

                async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                    if args.get("region") == "eu":
                        await asyncio.sleep(3600)  # effectively never returns (cut off by the timeout)
                    return DATA

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=bind_spec_builder, ref=BIND_REF_US),
                domain=SlowEuDomain(),
                on_error=_on_error,
            )
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Trend with region switch"})
                # Even with a slow ref, the compose response itself returns.
                assert not result.is_error
                assert result.meta is not None
                initial = result.meta[INITIAL_DATA_META_KEY]
                keys = list(initial.keys())
                # us (initial) / jp are co-embedded; the timed-out eu is not.
                assert BIND_REF_US in keys
                assert jp_ref in keys
                assert eu_ref not in keys
                # A timeout is reported to on_error like the per-ref fail-open.
                assert any(info.endpoint == "compose.initialData" for info in seen)

        asyncio.run(run())

    def test_resolves_refs_concurrently(self, tmp_path: Path) -> None:
        """8 slow refs of 100ms complete in well under 800ms (bounded-concurrency resolution, not serial)."""
        component_count = 8

        def ref_for(i: int) -> str:
            return f"query://sales/trend?granularity=month&metric=revenue&idx={i}"

        def n_component_builder(intent_arg: Intent, handles: list[Any]) -> UISpec:
            children = [f"c{i}" for i in range(component_count)]
            components: list[dict[str, Any]] = [
                {"id": "root", "type": "layout.stack", "props": {}, "children": children},
            ]
            for i in range(component_count):
                components.append(
                    {
                        "id": f"c{i}",
                        "type": "presentChart",
                        "props": {"kind": "line", "x": "month", "y": "revenue"},
                        "data": {"$ref": ref_for(i)},
                    }
                )
            return UISpec.model_validate(
                {
                    "kohaku": "0.1",
                    "intent": intent_arg.to_wire(),
                    "dataVersion": "x",
                    "components": components,
                    "events": [],
                    "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
                }
            )

        class SlowDomain:
            async def list_operations(self) -> list[Any]:
                return []

            async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                await asyncio.sleep(0.1)
                return DATA

        async def run() -> None:
            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=n_component_builder),
                domain=SlowDomain(),
            )
            async with connect(deps, _OPTIONS) as client:
                started = asyncio.get_event_loop().time()
                result = await client.call_tool("kohaku_compose", {"question": "8 components"})
                elapsed = asyncio.get_event_loop().time() - started
                assert not result.is_error
                assert result.meta is not None
                initial = result.meta[INITIAL_DATA_META_KEY]
                assert len(initial) == component_count
                # Serial resolution would take >= 0.8s (8 x 100ms); bounded concurrency keeps it well under that.
                assert elapsed < 0.8

        asyncio.run(run())

    def test_total_deadline_stops_waiting_for_never_resolving_refs(
        self, tmp_path: Path, monkeypatch: Any
    ) -> None:
        """The overall deadline cuts the wait short so the tool call still returns even with a ref that never resolves."""
        # See test_per_ref_timeout_skips_slow_ref's comment above: PRERESOLVE_TOTAL_TIMEOUT_S must be patched
        # on kohaku.host_mcp.initial_data (where _preresolve_initial_data actually reads it), not on
        # kohaku.host_mcp.server.
        import kohaku.host_mcp.initial_data as initial_data_mod

        monkeypatch.setattr(initial_data_mod, "PRERESOLVE_TOTAL_TIMEOUT_S", 0.05)
        jp_ref = "query://sales/trend?granularity=month&metric=revenue&region=jp"
        eu_ref = "query://sales/trend?granularity=month&metric=revenue&region=eu"

        class MostlyHangDomain:
            async def list_operations(self) -> list[Any]:
                return []

            async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                if args.get("region") == "eu":
                    await asyncio.sleep(3600)  # effectively never returns
                return DATA

        async def run() -> None:
            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=bind_spec_builder, ref=BIND_REF_US),
                domain=MostlyHangDomain(),
            )
            async with connect(deps, _OPTIONS) as client:
                # A response returns promptly even though eu never resolves (without the total deadline this
                # would hang until the per-ref timeout, 2s by default).
                started = asyncio.get_event_loop().time()
                result = await client.call_tool(
                    "kohaku_compose", {"question": "Trend with region switch"}
                )
                elapsed = asyncio.get_event_loop().time() - started
                assert not result.is_error
                assert result.meta is not None
                initial = result.meta[INITIAL_DATA_META_KEY]
                keys = list(initial.keys())
                assert BIND_REF_US in keys
                assert jp_ref in keys
                assert eu_ref not in keys
                # Discriminates the total deadline (patched to 0.05s) from the per-ref timeout (2s, not
                # patched here): without the total-deadline mechanism this would only return once the
                # per-ref timeout fired on eu_ref, i.e. after ~2s. See Minor #3 of the 2026-09-20 final
                # review -- this assertion is what makes the test actually exercise the total deadline.
                assert elapsed < 1.0

        asyncio.run(run())


class TestActionWritePath:
    class WriteDomain:
        async def list_operations(self) -> list[Any]:
            return [OperationDescriptor(name="annotate", description="sales annotate (write)")]

        async def invoke(self, op: str, args: Any, ctx: Any) -> object:
            if op == "annotate":
                return {"ok": True, "dataVersion": "sales@seed-2"}
            raise ValueError("unknown op")

    class WriteDomainWithoutAnnotate:
        """A domain that does not list annotate among its operations (to test write-scope dropping). Also
        serves "trend" (DATA) so a $ref alongside the dropped write scope pre-resolves without a spurious
        on_error entry unrelated to the write-scope drop being tested."""

        async def list_operations(self) -> list[Any]:
            return []

        async def invoke(self, op: str, args: Any, ctx: Any) -> object:
            if op == "annotate":
                return {"ok": True, "dataVersion": "sales@seed-2"}
            if op == "trend":
                return DATA
            raise ValueError("unknown op")

    @staticmethod
    async def _action_effects(action: str, payload: Any, result: Any) -> ActionEffects:
        if action != "annotate":
            return ActionEffects()
        refs = [r for r in payload.get("refs", []) if isinstance(r, str)]
        data_version = result.get("dataVersion") if isinstance(result, dict) else None
        if len(refs) == 0 or not isinstance(data_version, str):
            return ActionEffects(invalidates=refs)
        return ActionEffects(
            invalidates=refs, refVersions={r: data_version for r in refs}
        )

    def _write_deps(self, tmp_path: Path, *, with_effects: bool) -> McpHostDeps:
        return _deps(
            tmp_path,
            compose=make_compose_ctx(tmp_path, builder=write_spec_builder),
            domain=self.WriteDomain(),
            action_effects=self._action_effects if with_effects else None,
        )

    def test_action_is_app_only(self, tmp_path: Path) -> None:
        """kohaku_action is registered as app-only (visibility ['app'] / no resourceUri)."""

        async def run() -> None:
            async with connect(self._write_deps(tmp_path, with_effects=False), _OPTIONS) as client:
                tools = (await client.list_tools()).tools
                action = next(t for t in tools if t.name == "kohaku_action")
                assert action.meta is not None
                assert action.meta[VISIBILITY_META_KEY] == ["app"]
                assert _ui_meta(action.meta)["visibility"] == ["app"]  # type: ignore[index]
                assert RESOURCE_URI_META_KEY not in action.meta
                assert "resourceUri" not in (_ui_meta(action.meta) or {})

        asyncio.run(run())

    def test_write_capability_and_effects(self, tmp_path: Path) -> None:
        """verify passes with the compose-issued capability (write scope) and the side effects are reflected."""

        async def run() -> None:
            async with connect(self._write_deps(tmp_path, with_effects=True), _OPTIONS) as client:
                composed = await client.call_tool("kohaku_compose", {"question": "Annotation form"})
                capability = _capability_of(composed)
                assert "annotate" in capability

                result = await client.call_tool(
                    "kohaku_action",
                    {
                        "action": "annotate",
                        "payload": {"note": "review", "refs": [TREND_REF]},
                        "capability": capability,
                    },
                )
                assert not result.is_error
                structured = result.structured_content
                assert structured is not None
                assert structured["result"]["ok"] is True
                assert structured["invalidates"] == [TREND_REF]
                assert structured["refVersions"][TREND_REF] == "sales@seed-2"

        asyncio.run(run())

    def test_action_effects_failure_still_succeeds(self, tmp_path: Path) -> None:
        """Even if action_effects raises, the committed write returns success (only {result}) and the failure is recorded to on_error."""

        async def run() -> None:
            seen: list[McpErrorInfo] = []

            async def _boom_effects(action: str, payload: Any, result: Any) -> ActionEffects:
                raise RuntimeError("effects computation failed (test)")

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=write_spec_builder),
                domain=self.WriteDomain(),
                action_effects=_boom_effects,
                on_error=_on_error,
            )
            async with connect(deps, _OPTIONS) as client:
                composed = await client.call_tool("kohaku_compose", {"question": "Annotation form"})
                capability = _capability_of(composed)
                result = await client.call_tool(
                    "kohaku_action",
                    {
                        "action": "annotate",
                        "payload": {"note": "review", "refs": [TREND_REF]},
                        "capability": capability,
                    },
                )
                # The write is already committed, so success. The failed effects are omitted, leaving the backward-compatible {result} only.
                assert not result.is_error
                structured = result.structured_content
                assert structured is not None
                assert structured["result"]["ok"] is True
                assert "invalidates" not in structured
                assert "refVersions" not in structured
                # The failure is recorded to observability (on_error) (delivery is not dragged down).
                assert any(info.endpoint == "kohaku_action" for info in seen)

        asyncio.run(run())

    def test_write_denied_without_scope(self, tmp_path: Path) -> None:
        """A capability without a write scope is verify-denied -> toolError (not an RPC exception)."""

        async def run() -> None:
            async with connect(self._write_deps(tmp_path, with_effects=True), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_action",
                    {
                        "action": "annotate",
                        "payload": {},
                        "capability": "cap:query://sales/other",
                    },
                )
                assert result.is_error is True
                assert "capability denied" in result.content[0].text  # type: ignore[union-attr]

        asyncio.run(run())

    @staticmethod
    def _write_spec_builder_with_ref(intent_arg: Intent, handles: list[Any]) -> UISpec:
        """Distinct from write_spec_builder: also declares a $ref, so dropping the write scope still leaves
        a non-empty capability token. SimpleAuthz (_helpers.py) matches by ref-prefix rather than exact
        kind+ref, so an entirely empty scope list would make its prefix check ("".startswith trivially
        matching everything) spuriously grant access — a quirk of this test double, not of the production
        capability-filtering logic under test."""
        return UISpec.model_validate(
            {
                "kohaku": "0.1",
                "intent": intent_arg.to_wire(),
                "dataVersion": "x",
                "components": [
                    {"id": "root", "type": "layout.stack", "props": {}, "children": ["f", "t"]},
                    {"id": "f", "type": "presentForm", "props": {"action": "annotate"}},
                    {"id": "t", "type": "presentTable", "props": {}, "data": {"$ref": TREND_REF}},
                ],
                "events": [{"on": "f.submit", "emit": "action.invoke", "payload": {}}],
                "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
            }
        )

    def test_unlisted_action_has_no_write_scope(self, tmp_path: Path) -> None:
        """An action not listed by DomainPort.list_operations gets no write scope, and kohaku_action itself
        rejects it as unknown (isError), and on_error is notified (endpoint compose.capability)."""

        async def run() -> None:
            seen: list[McpErrorInfo] = []

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=self._write_spec_builder_with_ref),
                domain=self.WriteDomainWithoutAnnotate(),
                action_effects=self._action_effects,
                on_error=_on_error,
            )
            async with connect(deps, _OPTIONS) as client:
                composed = await client.call_tool("kohaku_compose", {"question": "Annotation form"})
                capability = _capability_of(composed)
                # annotate is not among WriteDomainWithoutAnnotate's list_operations(), so its write scope was dropped.
                assert "annotate" not in capability
                assert any(info.endpoint == "compose.capability" for info in seen)

                result = await client.call_tool(
                    "kohaku_action",
                    {
                        "action": "annotate",
                        "payload": {"note": "review", "refs": [TREND_REF]},
                        "capability": capability,
                    },
                )
                assert result.is_error is True
                # The kohaku_action handler's own allowed-actions check (the same DomainPort.list_operations()
                # source that dropped the write scope above) rejects the action before capability verification.
                assert "unknown action" in result.content[0].text  # type: ignore[union-attr]

        asyncio.run(run())


class TestEventTool:
    def test_event_recomposes_via_gui_action(self, tmp_path: Path) -> None:
        """Recomposes a component event as an Intent delta and returns UI + initial data."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {}},
                        "on": "c.pointClick",
                        "payload": {"month": "2026-05"},
                    },
                )
                assert not result.is_error
                spec = parse_spec(result.structured_content["spec"])
                assert spec.provenance.tier == "L0"
                assert result.meta is not None
                assert INITIAL_DATA_META_KEY in result.meta

        asyncio.run(run())


def _nested_object(depth: int) -> dict[str, Any]:
    """A dict literal nested `depth` levels deep (a bare {"leaf": True} is depth 1). Mirrors
    host_rest/test_bodies.py's own _nested_object."""
    obj: dict[str, Any] = {"leaf": True}
    for _ in range(1, depth):
        obj = {"nested": obj}
    return obj


class TestEventActionPayloadDepthCap:
    """kohaku_event's payload / intent.params and kohaku_action's payload are all capped at
    MAX_JSON_OBJECT_DEPTH (32) — TS validates the same fields via JsonObjectSchema at the SDK's own
    input-schema layer; Python has no such layer, so server.py's _json_depth_ok enforces it in-handler."""

    def test_event_payload_over_32_is_rejected(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {}},
                        "on": "c.pointClick",
                        "payload": _nested_object(33),
                    },
                )
                assert result.is_error
                assert "nesting exceeds the maximum depth (32)" in result.content[0].text  # type: ignore[union-attr]

        asyncio.run(run())

    def test_event_intent_params_over_32_is_rejected(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": _nested_object(33)},
                        "on": "c.pointClick",
                        "payload": {},
                    },
                )
                assert result.is_error
                assert "nesting exceeds the maximum depth (32)" in result.content[0].text  # type: ignore[union-attr]

        asyncio.run(run())

    def test_event_payload_at_32_is_accepted(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {"canonical": "sales.trend", "params": {}},
                        "on": "c.pointClick",
                        "payload": _nested_object(32),
                    },
                )
                assert not result.is_error

        asyncio.run(run())

    def test_action_payload_over_32_is_rejected(self, tmp_path: Path) -> None:
        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                composed = await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}
                )
                capability = _capability_of(composed)
                result = await client.call_tool(
                    "kohaku_action",
                    {"action": "annotate", "payload": _nested_object(33), "capability": capability},
                )
                assert result.is_error
                assert "nesting exceeds the maximum depth (32)" in result.content[0].text  # type: ignore[union-attr]

        asyncio.run(run())


def test_no_lingering_script_marker_regex() -> None:
    """Regression guard: the snapshot placeholder regex has the expected shape (detects embedding-marker drift)."""
    from kohaku.host_mcp.snapshot import SNAPSHOT_PLACEHOLDER_RE

    assert isinstance(SNAPSHOT_PLACEHOLDER_RE, re.Pattern)
    assert SNAPSHOT_PLACEHOLDER_RE.search(RENDERER_HTML_SNAPSHOT) is not None


def test_inject_snapshot_escapes_script_close_tag_variants() -> None:
    """Regression: case/whitespace </script> variants (</SCRIPT> / </script >) are also \\u003c-escaped so they do
    not appear in the body as raw closing tags and round-trip through json.loads (stored-XSS prevention).

    The old implementation (exact `</script>` escaping) let these variants pass through, and the HTML parser
    terminated the script early, making injection possible. The "leave no `<`" approach closes the variant-dependent gap.
    """
    from kohaku.host_mcp.snapshot import inject_snapshot
    from kohaku.spec import TabularData, UISpec

    # Plant closing-tag variants with uppercase, trailing whitespace, tab, and newline into both the spec params and data.
    variants = "</SCRIPT> </script > </ScRiPt\t> </script\n>"
    spec = UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": {
                "canonical": "sales.custom",
                "params": {"request": variants},
                "hash": "sha256:" + "1" * 64,
            },
            "dataVersion": "sales@seed-1",
            "components": [{"id": "root", "type": "layout.stack", "props": {}}],
            "events": [],
            "provenance": {"tier": "L0", "composedBy": "composer@0.1.0", "cache": "miss"},
        }
    )
    data = {
        "query://sales/trend": TabularData.model_validate(
            {
                "columns": [{"key": "month", "type": "string"}],
                "rows": [{"month": variants}],
                "dataVersion": "sales@seed-1",
            }
        )
    }

    html = inject_snapshot(RENDERER_HTML_SNAPSHOT, spec, data)

    # Extract the embedded interval (the JSON body after placeholder replacement). Since no `<` remains in the embedded
    # JSON, the first </script> right after start is the real closing tag.
    open_tag = '<script id="kohaku-snapshot" type="application/json">'
    start = html.index(open_tag) + len(open_tag)
    end = html.index("</script>", start)
    raw = html[start:end]
    # No `<` remains in the interval = no closing-tag variant is valid in the HTML.
    assert "<" not in raw
    # `<` is a JSON escape, so json.loads restores it to the original variant string as-is.
    parsed = json.loads(raw)
    assert parsed["spec"]["intent"]["params"]["request"] == variants
    assert parsed["data"]["query://sales/trend"]["rows"][0]["month"] == variants


class TestLegacyUiResource:
    """UIResource co-emission for mcp-ui legacy host compatibility (legacy_ui_resource opt-in)."""

    def test_appends_ui_resource_when_enabled(self, tmp_path: Path) -> None:
        """When enabled, content[1] co-emits a ui:// UIResource (self-contained snapshot)."""

        async def run() -> None:
            options = AttachOptions(
                renderer_html=RENDERER_HTML_SNAPSHOT, legacy_ui_resource=True
            )
            async with connect(_deps(tmp_path), options) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert not result.is_error
                # content[0] is the unchanged text fallback (MCPAPP-FBK-001).
                assert result.content[0].type == "text"
                # content[1] is the mcp-ui legacy host's detection form (resource + ui:// + text/html).
                assert len(result.content) == 2
                embedded = result.content[1]
                assert embedded.type == "resource"
                spec = parse_spec(result.structured_content["spec"])
                assert str(embedded.resource.uri) == f"ui://kohaku/view/{spec.intent.hash}"
                assert embedded.resource.mime_type == "text/html"
                # The body is the self-contained snapshot (the placeholder is replaced with {spec, data}).
                # Being the text form (TextResourceContents) is also under check (not emitted as blob).
                from mcp.types import TextResourceContents

                assert isinstance(embedded.resource, TextResourceContents)
                assert '<script id="kohaku-snapshot"' in embedded.resource.text
                assert ">null</script>" not in embedded.resource.text
                assert '"rows"' in embedded.resource.text

        asyncio.run(run())

    def test_default_off_keeps_content_text_only(self, tmp_path: Path) -> None:
        """By default (unspecified), content is text only (fully backward compatible)."""

        async def run() -> None:
            async with connect(_deps(tmp_path), _OPTIONS) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                assert len(result.content) == 1

        asyncio.run(run())

    def test_snapshot_failure_is_fail_open(self, tmp_path: Path) -> None:
        """An assembly failure (no placeholder) is fail-open with no co-emission + observation-hook notification."""

        async def run() -> None:
            seen: list[McpErrorInfo] = []

            def _on_error(info: McpErrorInfo) -> None:
                seen.append(info)

            deps = _deps(tmp_path, on_error=_on_error)
            options = AttachOptions(renderer_html=RENDERER_HTML_PLAIN, legacy_ui_resource=True)
            async with connect(deps, options) as client:
                result = await client.call_tool("kohaku_compose", {"question": "Monthly sales trend"})
                # A normal response with no co-emission (compose itself stays a success).
                assert not result.is_error
                assert len(result.content) == 1
                assert any(s.endpoint == "compose.legacyUiResource" for s in seen)

        asyncio.run(run())


# --- Symmetric view audit via a ViewRecorder, and bounded snapshot resolution shared with initial-data
# preresolution (see server.py §2 #6 / #7). Tool-handler cancellation propagation (§4.5 R1) is not mirrored
# here: this mcp SDK version exposes no per-call cancellation object on RequestContext for a tool handler to
# check or thread into compose()'s existing `abort` parameter — see the NOTE comment above `_call_tool` in
# server.py.


class _RecordingRecorder:
    """A minimal ViewRecorderProtocol double that records every composed/interacted/fallback call."""

    def __init__(self) -> None:
        self.composed_calls: list[dict[str, Any]] = []
        self.interacted_calls: list[dict[str, Any]] = []
        self.fallback_calls: list[dict[str, Any]] = []

    async def composed(self, *, spec: Any, trace: Any, surface: str, **_kwargs: Any) -> None:
        self.composed_calls.append({"surface": surface})

    async def interacted(
        self,
        *,
        intent_hash: str,
        component_id: str,
        on: str,
        payload: Any,
        surface: str,
        **_kwargs: Any,
    ) -> None:
        self.interacted_calls.append(
            {
                "intent_hash": intent_hash,
                "component_id": component_id,
                "on": on,
                "payload": payload,
                "surface": surface,
            }
        )

    async def fallback(
        self, *, spec: Any, reason: str, kind: str, surface: str, **_kwargs: Any
    ) -> None:
        self.fallback_calls.append({"reason": reason, "kind": kind, "surface": surface})


class TestViewRecorder:
    """A wired ViewRecorderProtocol records composed/interacted/fallback symmetrically with the
    REST profile's ViewRecorderProtocol, and takes priority over the legacy on_composed hook."""

    def test_composed_and_fallback_recorded_on_compose_and_interacted_on_event(
        self, tmp_path: Path
    ) -> None:
        async def run() -> None:
            recorder = _RecordingRecorder()
            # A ComposeContext with no fixedSpecs, scripted to always fail schema validation, so every
            # compose exhausts L1 into the deterministic fallback (provenance.fallback.kind = "generation").
            # FakeLlm does not advance its script index on a validation failure, so one scripted object
            # suffices to fail every attempt across both tool calls below.
            deps = _deps(
                tmp_path,
                compose=make_no_fixed_compose_ctx(
                    tmp_path, llm=FakeLlm(objects=[{"components": [], "events": []}])
                ),
                recorder=recorder,
            )
            async with connect(deps, _OPTIONS) as client:
                composed = await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}
                )
                assert not composed.is_error
                assert recorder.composed_calls == [{"surface": "mcp-app"}]
                assert len(recorder.fallback_calls) == 1
                assert recorder.fallback_calls[0]["kind"] == "generation"

                spec = parse_spec(composed.structured_content["spec"])
                event_result = await client.call_tool(
                    "kohaku_event",
                    {
                        "intent": {
                            "canonical": spec.intent.canonical,
                            "params": spec.intent.params,
                        },
                        "on": "c.select",
                        "payload": {"month": "2026-05"},
                    },
                )
                assert not event_result.is_error
                # interacted is recorded exactly once, from the tool call's own arguments (not the Spec).
                assert recorder.interacted_calls == [
                    {
                        "intent_hash": spec.intent.hash,
                        "component_id": "c",
                        "on": "c.select",
                        "payload": {"month": "2026-05"},
                        "surface": "mcp-app",
                    }
                ]
                # The recompose triggered by kohaku_event goes through the same audit path too.
                assert len(recorder.composed_calls) == 2
                assert len(recorder.fallback_calls) == 2

        asyncio.run(run())

    def test_recorder_takes_priority_over_legacy_on_composed(self, tmp_path: Path) -> None:
        async def run() -> None:
            recorder = _RecordingRecorder()
            on_composed_calls = 0

            async def _on_composed(spec: Any, trace: Any) -> None:
                nonlocal on_composed_calls
                on_composed_calls += 1

            deps = _deps(tmp_path, recorder=recorder, on_composed=_on_composed)
            async with connect(deps, _OPTIONS) as client:
                result = await client.call_tool(
                    "kohaku_compose", {"question": "Monthly sales trend"}
                )
                assert not result.is_error
                assert recorder.composed_calls == [{"surface": "mcp-app"}]
                assert on_composed_calls == 0

        asyncio.run(run())


class TestBoundedSnapshotResolution:
    """kohaku_render_snapshot resolves refs via the same bounded-concurrency + overall-deadline
    primitive (_resolve_refs_bounded) as the initial-data preresolution, instead of the previous one-ref-at-a-
    time loop with neither a per-ref timeout nor an overall deadline."""

    def test_render_snapshot_bounded_concurrency_with_20_refs(self, tmp_path: Path) -> None:
        component_count = 20

        def ref_for(i: int) -> str:
            return f"query://sales/trend?granularity=month&metric=revenue&idx={i}"

        def n_component_builder(intent_arg: Intent, handles: list[Any]) -> UISpec:
            children = [f"c{i}" for i in range(component_count)]
            components: list[dict[str, Any]] = [
                {"id": "root", "type": "layout.stack", "props": {}, "children": children},
            ]
            for i in range(component_count):
                components.append(
                    {
                        "id": f"c{i}",
                        "type": "presentChart",
                        "props": {"kind": "line", "x": "month", "y": "revenue"},
                        "data": {"$ref": ref_for(i)},
                    }
                )
            return UISpec.model_validate(
                {
                    "kohaku": "0.1",
                    "intent": intent_arg.to_wire(),
                    "dataVersion": "x",
                    "components": components,
                    "events": [],
                    "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
                }
            )

        in_flight = 0
        max_in_flight = 0

        class SlowDomain:
            async def list_operations(self) -> list[Any]:
                return []

            async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                nonlocal in_flight, max_in_flight
                in_flight += 1
                max_in_flight = max(max_in_flight, in_flight)
                await asyncio.sleep(0.02)
                in_flight -= 1
                return DATA

        async def run() -> None:
            async def _writer(file_name: str, html: str) -> str:
                return f"/abs/{file_name}"

            options = AttachOptions(renderer_html=RENDERER_HTML_SNAPSHOT, snapshot_writer=_writer)
            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=n_component_builder),
                domain=SlowDomain(),
            )
            async with connect(deps, options) as client:
                result = await client.call_tool(
                    "kohaku_render_snapshot", {"question": "20 components"}
                )
                assert not result.is_error

        asyncio.run(run())
        # Bounded concurrency: more than one worker ran at once (not serial, unlike the pre-fix one-at-a-time
        # loop), but never exceeding the pool size (PRERESOLVE_CONCURRENCY = 8).
        assert 2 <= max_in_flight <= 8

    def test_legacy_ui_resource_reuses_preresolved_refs_instead_of_re_invoking(
        self, tmp_path: Path
    ) -> None:
        calls: list[tuple[str, dict[str, Any]]] = []

        class CountingDomain:
            async def list_operations(self) -> list[Any]:
                return []

            async def invoke(self, op: str, args: Any, ctx: Any) -> object:
                calls.append((op, dict(args)))
                return DATA

        async def run() -> None:
            options = AttachOptions(renderer_html=RENDERER_HTML_SNAPSHOT, legacy_ui_resource=True)
            deps = _deps(
                tmp_path,
                compose=make_compose_ctx(tmp_path, builder=bind_spec_builder, ref=BIND_REF_US),
                domain=CountingDomain(),
            )
            async with connect(deps, options) as client:
                result = await client.call_tool(
                    "kohaku_compose", {"question": "Trend with region switch"}
                )
                assert not result.is_error

        asyncio.run(run())
        # 3 bind variants (us/eu/jp), each resolved exactly once. Before this fix, the legacyUiResource
        # snapshot co-emission re-resolved the identical ref set a second time, doubling domain.invoke calls.
        assert len(calls) == 3
