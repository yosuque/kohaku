"""Tests for capability negotiation (negotiate)."""

from __future__ import annotations

from typing import Any

from kohaku.registry import SurfaceCapabilities, core_catalog, negotiate, resolve_catalog
from kohaku.spec import UISpec

_CATALOG = resolve_catalog(core_catalog())


def _spec(components: list[dict[str, Any]], **overrides: Any) -> UISpec:
    base: dict[str, Any] = {
        "kohaku": "0.2",
        "intent": {"canonical": "t.v", "params": {}, "hash": "sha256:" + "0" * 64},
        "dataVersion": "v1",
        "components": components,
        "provenance": {"tier": "L1", "composedBy": "test", "cache": "miss"},
    }
    base.update(overrides)
    return UISpec.model_validate(base)


_FULL_SURFACE = SurfaceCapabilities(
    supports={d.type: "*" for d in core_catalog().components}
)


def test_no_downgrade_when_all_supported() -> None:
    spec = _spec([{"id": "root", "type": "layout.stack", "props": {}}])
    result = negotiate(spec, _CATALOG, _FULL_SURFACE)
    assert result.downgrades == []
    assert result.spec is spec


def test_chart_downgrades_to_spreadsheet() -> None:
    spec = _spec(
        [
            {
                "id": "root",
                "type": "presentChart",
                "version": "1.1.0",
                "props": {"kind": "bar", "x": "r", "y": "v"},
                "data": {"$ref": "query://s/p"},
            }
        ]
    )
    surface = SurfaceCapabilities(
        supports={"presentSpreadsheet": "*", "presentMarkdown": "*", "layout.stack": "*"}
    )
    result = negotiate(spec, _CATALOG, surface)
    assert len(result.downgrades) == 1
    d = result.downgrades[0]
    assert (d.from_, d.to) == ("presentChart", "presentSpreadsheet")
    node = result.spec.components[0]
    assert node.type == "presentSpreadsheet"
    assert node.props == {"editable": False}  # mapProps applied
    assert node.data is not None  # spreadsheet accepts data, so it is kept
    assert node.version == "1.1.0"  # the downgrade target's catalog version is pinned
    # a negotiation trace remains in provenance
    assert result.spec.provenance.fallback is not None
    assert result.spec.provenance.fallback.kind == "negotiation"


def test_chain_to_terminal_markdown() -> None:
    """On a surface that also lacks presentChart -> spreadsheet, it chains down to presentMarkdown."""
    spec = _spec(
        [
            {
                "id": "root",
                "type": "presentChart",
                "props": {"kind": "bar", "x": "r", "y": "v"},
                "data": {"$ref": "query://s/p"},
            }
        ]
    )
    surface = SurfaceCapabilities(supports={"presentMarkdown": "*"})
    result = negotiate(spec, _CATALOG, surface)
    node = result.spec.components[0]
    assert node.type == "presentMarkdown"
    assert node.data is None  # markdown is data:"none", so it is dropped


def test_unsupported_without_chain_falls_to_terminal() -> None:
    spec = _spec([{"id": "root", "type": "layout.stack", "props": {}}])
    surface = SurfaceCapabilities(supports={"presentMarkdown": "*"})
    result = negotiate(spec, _CATALOG, surface)
    node = result.spec.components[0]
    assert node.type == "presentMarkdown"
    assert result.downgrades[0].reason.endswith("no usable fallback chain")


def test_sandbox_html_respects_max_tier() -> None:
    artifact = {"inline": "<html></html>", "sha256": "0" * 64}
    spec = _spec(
        [{"id": "root", "type": "sandbox.html", "props": {}, "artifact": artifact}]
    )
    # On an L2-allowed surface it stays as-is
    ok = negotiate(spec, _CATALOG, SurfaceCapabilities(supports={}, maxTier="L2"))
    assert ok.downgrades == []
    # On a surface up to L1, it is downgraded to presentMarkdown
    downgraded = negotiate(spec, _CATALOG, SurfaceCapabilities(supports={}, maxTier="L1"))
    assert downgraded.spec.components[0].type == "presentMarkdown"
    assert downgraded.downgrades[0].reason == "surface does not allow tier L2"


def test_semver_range_check() -> None:
    """If the version is out of range, downgrade it as unsupported."""
    spec = _spec(
        [
            {
                "id": "root",
                "type": "presentSpreadsheet",
                "version": "1.1.0",
                "props": {},
                "data": {"$ref": "query://s/p"},
            }
        ]
    )
    surface = SurfaceCapabilities(
        supports={"presentSpreadsheet": "~1.0.0", "presentMarkdown": "*"}
    )
    result = negotiate(spec, _CATALOG, surface)
    assert result.spec.components[0].type == "presentMarkdown"
