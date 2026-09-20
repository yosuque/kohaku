"""Catalog tests (core loading / merge / validation)."""

from __future__ import annotations

import json
from importlib import resources
from typing import Any

import pytest

from kohaku.registry import (
    CapabilityDecl,
    Catalog,
    CatalogConflictError,
    ComponentDefinition,
    ComponentDefinitionError,
    PropsSchema,
    core_catalog,
    define_component,
    resolve_catalog,
)


def _def(
    type_: str = "x.widget", version: str = "1.0.0", **kwargs: Any
) -> ComponentDefinition:
    return define_component(
        ComponentDefinition(
            type=type_,
            version=version,
            description="test component",
            propsSchema=PropsSchema(
                {"type": "object", "properties": {"label": {"type": "string"}}, "required": []}
            ),
            capabilities=CapabilityDecl(events=[], data="none", children="none"),
            **kwargs,
        )
    )


class TestCoreCatalog:
    def test_loads_every_exported_component(self) -> None:
        """The expected identifier set is derived from the exported catalog JSON (the TS source
        of truth, `python/kohaku/src/kohaku/registry/_data/core-catalog.json`), not hard-coded —
        so this test never needs a manual list/count bump when a component is added or removed.

        Asserts set equality of component `type` identifiers between `core_catalog()` and the
        JSON, so it catches a loader that drops, duplicates, or renames an entry (a length-only
        comparison cannot: it stays equal under a drop+duplicate or a rename, since both leave the
        count unchanged). It is still not a check on the catalog's *contents* (each component's
        version, propsSchema, capabilities, etc.) — content is pinned by the two fingerprint
        tests: `packages/registry/test/catalog.test.ts` and
        `python/kohaku/tests/registry/test_fingerprint.py`."""
        json_components = json.loads(
            resources.files("kohaku.registry._data")
            .joinpath("core-catalog.json")
            .read_text("utf-8")
        )["components"]
        json_types = {c["type"] for c in json_components}
        loaded_types = {d.type for d in core_catalog().components}
        assert loaded_types == json_types

    def test_all_fallback_types_have_map_props(self) -> None:
        """Every fallbackType in the JSON has a corresponding map_props on the Python side
        (if not, core_catalog() raises RuntimeError at construction)."""
        for definition in core_catalog().components:
            if definition.fallback is not None:
                assert callable(definition.fallback.map_props)

    def test_fallback_chains_terminate(self) -> None:
        """A fallback chain always reaches a terminal (presentMarkdown or no fallback)."""
        resolved = resolve_catalog(core_catalog())
        for definition in core_catalog().components:
            seen = {definition.type}
            current = definition
            while current.fallback is not None:
                next_type = current.fallback.type
                assert next_type not in seen, f"fallback cycle: {definition.type}"
                seen.add(next_type)
                next_def = resolved.get(next_type)
                assert next_def is not None, f"fallback target {next_type} is not in the catalog"
                current = next_def


class TestFallbackMapPropsNullish:
    """D4: fallback mapProps falls an explicit None to the default text (matching TS's `??`).

    Because Python's dict.get(key, default) only defaults a missing key, an explicit None was leaking as
    js_string(None)="null". TS (`p["x"] ?? default`) also falls null to the default.
    """

    def test_present_metric_null_label_uses_empty_default(self) -> None:
        from kohaku.registry.core import _FALLBACK_MAP_PROPS

        f = _FALLBACK_MAP_PROPS["presentMetric"]
        assert f({"label": None}) == {"markdown": "****"}  # None -> "" (not "null")
        assert f({}) == {"markdown": "****"}  # missing -> ""
        assert f({"label": "Sales"}) == {"markdown": "**Sales**"}

    def test_loading_null_vs_empty_label(self) -> None:
        from kohaku.registry.core import _FALLBACK_MAP_PROPS

        f = _FALLBACK_MAP_PROPS["ui.loading"]
        assert f({"label": None}) == {"markdown": "Loading…"}  # None -> default
        assert f({}) == {"markdown": "Loading…"}  # missing -> default
        # An empty string is falsy but not nullish, so it is kept (not fallen to the default).
        assert f({"label": ""}) == {"markdown": ""}
        assert f({"label": "Fetching"}) == {"markdown": "Fetching"}

    def test_toast_null_message_uses_empty_default(self) -> None:
        from kohaku.registry.core import _FALLBACK_MAP_PROPS

        f = _FALLBACK_MAP_PROPS["overlay.toast"]
        assert f({"message": None}) == {"markdown": ""}  # None -> "" (not "null")
        assert f({"message": "Done"}) == {"markdown": "Done"}

    def test_action_button_and_control_select_null_coalescing(self) -> None:
        from kohaku.registry.core import _FALLBACK_MAP_PROPS

        button = _FALLBACK_MAP_PROPS["action.button"]
        assert button({"label": None}) == {
            "markdown": '(Action "" is not available on this surface)'
        }
        select = _FALLBACK_MAP_PROPS["control.select"]
        # explicit label None -> value, and value explicit None -> "" (TS: label ?? value ?? "").
        assert select({"label": None, "value": None}) == {"markdown": "****"}
        assert select({"label": None, "value": "v"}) == {"markdown": "**v**"}
        assert select({"label": "L", "value": "v"}) == {"markdown": "**L**"}


class TestDefineComponent:
    def test_rejects_bad_type(self) -> None:
        with pytest.raises(ComponentDefinitionError):
            _def(type_="1bad")

    def test_rejects_bad_semver(self) -> None:
        with pytest.raises(ComponentDefinitionError):
            _def(version="1.0")

    def test_rejects_empty_description(self) -> None:
        with pytest.raises(ComponentDefinitionError):
            define_component(
                ComponentDefinition(
                    type="x.y",
                    version="1.0.0",
                    description="  ",
                    propsSchema=PropsSchema({"type": "object", "properties": {}}),
                    capabilities=CapabilityDecl(events=[], data="none", children="none"),
                )
            )


class TestResolveCatalog:
    def test_contribution_adds_new_type(self) -> None:
        resolved = resolve_catalog(core_catalog(), Catalog(components=[_def()]))
        assert resolved.get("x.widget") is not None
        assert len(resolved.list()) == 17

    def test_override_requires_higher_semver(self) -> None:
        base = Catalog(components=[_def(version="1.1.0")])
        with pytest.raises(CatalogConflictError):
            resolve_catalog(core_catalog(), base, Catalog(components=[_def(version="1.1.0")]))
        resolved = resolve_catalog(
            core_catalog(), base, Catalog(components=[_def(version="1.2.0")])
        )
        definition = resolved.get("x.widget")
        assert definition is not None and definition.version == "1.2.0"

    def test_fingerprint_changes_on_contribution(self) -> None:
        base = resolve_catalog(core_catalog())
        extended = resolve_catalog(core_catalog(), Catalog(components=[_def()]))
        assert base.fingerprint != extended.fingerprint


class TestValidateAgainstCatalog:
    def test_unknown_type(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate([{"id": "a", "type": "no.such", "props": {}}])
        assert [i.code for i in result.issues] == ["UNKNOWN_TYPE"]

    def test_props_invalid(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [{"id": "a", "type": "text.heading", "props": {"level": 9, "text": "t"}}]
        )
        assert [i.code for i in result.issues] == ["PROPS_INVALID"]

    def test_normalized_fills_version_and_defaults(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate([{"id": "a", "type": "layout.stack", "props": {}}])
        assert result.issues == []
        node = result.normalized[0]
        assert node["version"] == "1.0.0"
        # equivalent to zod .default(): direction / gap are filled
        assert node["props"] == {"direction": "vertical", "gap": "md"}

    def test_props_unknown_keys_are_stripped(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [{"id": "a", "type": "text.heading", "props": {"level": 2, "text": "t", "junk": 1}}]
        )
        assert result.issues == []
        assert "junk" not in result.normalized[0]["props"]

    def test_data_required_and_forbidden(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [
                {"id": "a", "type": "presentChart", "props": {"kind": "bar", "x": "r", "y": "v"}},
                {
                    "id": "b",
                    "type": "text.heading",
                    "props": {"level": 2, "text": "t"},
                    "data": {"$ref": "query://s/p"},
                },
            ]
        )
        assert sorted(i.code for i in result.issues) == ["DATA_FORBIDDEN", "DATA_REQUIRED"]

    def test_children_not_supported(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [{"id": "a", "type": "text.heading", "props": {"level": 1, "text": "t"}, "children": ["b"]}]
        )
        assert [i.code for i in result.issues] == ["CHILDREN_NOT_SUPPORTED"]

    def test_event_not_supported(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [{"id": "a", "type": "text.heading", "props": {"level": 1, "text": "t"}}],
            [{"on": "a.click", "emit": "intent.patch", "payload": {}}],
        )
        assert [i.code for i in result.issues] == ["EVENT_NOT_SUPPORTED"]

    def test_event_without_dot_is_reported(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [{"id": "a", "type": "text.heading", "props": {"level": 1, "text": "t"}}],
            [{"on": "a", "emit": "intent.patch", "payload": {}}],
        )
        assert [i.code for i in result.issues] == ["EVENT_NOT_SUPPORTED"]

    def test_non_string_on_is_reported_not_crash(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [{"id": "a", "type": "text.heading", "props": {"level": 1, "text": "t"}}],
            [{"on": 123, "emit": "intent.patch", "payload": {}}],
        )
        assert [i.code for i in result.issues] == ["EVENT_NOT_SUPPORTED"]

    def test_sandbox_html_is_exempt(self) -> None:
        resolved = resolve_catalog(core_catalog())
        result = resolved.validate(
            [{"id": "a", "type": "sandbox.html", "props": {}, "artifact": {"inline": "<html/>"}}]
        )
        assert result.issues == []
