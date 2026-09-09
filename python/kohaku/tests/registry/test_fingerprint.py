"""TS-compatibility tests for fingerprint (golden values are packages/registry's run results)."""

from __future__ import annotations

from kohaku.registry import ComponentDefinition, core_catalog, fnv1a64, resolve_catalog
from kohaku.registry.catalog import Catalog
from kohaku.registry.props_schema import PropsSchema
from kohaku.registry.types import CapabilityDecl, ImplementationDecl


def test_fnv1a64_matches_ts() -> None:
    assert fnv1a64("") == "cbf29ce484222325"
    assert fnv1a64("abc") == "e71fa2190541574b"
    # Outside the BMP (😀) is folded as 2 UTF-16 surrogate-pair code units (charCodeAt compatible)
    assert fnv1a64("日本語😀") == "4858d2e6a500d80b"


def test_core_catalog_fingerprint_matches_ts() -> None:
    """The core catalog's fingerprint matches the TS implementation (resolveCatalog(coreCatalog).fingerprint).

    A mismatch means either catalog-content drift (a missed re-run of export-core-catalog) or an
    implementation difference in fnv1a64 / sorting. It is a cache-key component, so it must match across languages.
    """
    assert resolve_catalog(core_catalog()).fingerprint == "613c927375d8b18a"


def _promoted(html: str) -> ComponentDefinition:
    return ComponentDefinition(
        type="promoted.widget",
        version="1.0.0",
        description="promoted widget",
        propsSchema=PropsSchema({"type": "object", "properties": {}}),
        capabilities=CapabilityDecl(events=[], data="required", children="none"),
        implementation=ImplementationDecl(kind="sandbox-template", html=html),
    )


def test_sandbox_template_html_changes_fingerprint() -> None:
    """Two contributions with the same type@version but different sandbox-template html yield
    different fingerprints; identical html yields the same fingerprint (cross-checked against TS)."""
    a = resolve_catalog(core_catalog(), Catalog(components=[_promoted("<div>A</div>")]))
    b = resolve_catalog(core_catalog(), Catalog(components=[_promoted("<div>B</div>")]))
    a_again = resolve_catalog(core_catalog(), Catalog(components=[_promoted("<div>A</div>")]))

    assert a.fingerprint != b.fingerprint
    assert a.fingerprint == a_again.fingerprint
