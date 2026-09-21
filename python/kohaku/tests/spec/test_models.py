"""zod-semantics-compatibility tests for the schema models."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from kohaku.spec import (
    ComponentNode,
    DataRef,
    LeafPredicate,
    Provenance,
    SandboxArtifactRef,
    UISpec,
    canonical_stringify,
    parse_spec,
)


def test_example_spec_round_trip(example_spec_data: dict[str, Any]) -> None:
    """parse → to_wire is byte-identical to the input (reconciled in canonical form)."""
    spec = parse_spec(example_spec_data)
    assert canonical_stringify(spec.to_wire()) == canonical_stringify(example_spec_data)


def test_defaults_are_filled(example_spec_data: dict[str, Any]) -> None:
    """Equivalent to zod .default(): props={} / events=[] are filled at parse time."""
    minimal = {
        "kohaku": "0.1",
        "intent": example_spec_data["intent"],
        "dataVersion": "v1",
        "components": [{"id": "root", "type": "text.heading"}],
        "provenance": {"tier": "L0", "composedBy": "test", "cache": "miss"},
    }
    spec = UISpec.model_validate(minimal)
    assert spec.components[0].props == {}
    assert spec.events == []
    wire = spec.to_wire()
    assert wire["components"][0]["props"] == {}
    assert wire["events"] == []


def test_unknown_keys_are_stripped() -> None:
    """Equivalent to zod strip: unknown keys on a non-strict model are silently dropped."""
    node = ComponentNode.model_validate(
        {"id": "root", "type": "x", "unknownKey": 1, "props": {}}
    )
    assert "unknownKey" not in node.to_wire()


def test_data_ref_rejects_bulk_data() -> None:
    """strict: keys other than $ref / bind (bulk contamination such as rows) are rejected, not stripped."""
    with pytest.raises(ValidationError):
        DataRef.model_validate({"$ref": "query://s/p", "rows": [{"a": 1}]})


def test_data_ref_rejects_fragment() -> None:
    with pytest.raises(ValidationError):
        DataRef.model_validate({"$ref": "query://s/p#frag"})


def test_explicit_null_for_optional_is_rejected() -> None:
    """Equivalent to zod .optional(): allow key absence but reject explicit null."""
    with pytest.raises(ValidationError):
        ComponentNode.model_validate({"id": "a", "type": "x", "children": None})
    ComponentNode.model_validate({"id": "a", "type": "x"})  # absence is OK


def test_provenance_composed_at_requires_seconds() -> None:
    """Pins ISO_DATETIME_PATTERN's seconds requirement for provenance.composedAt — mirrors the TS side's
    z.iso.datetime() (zod 4.6+ requires seconds by default), which happened to close a gap with this
    pattern. Nothing pinned this in either language before, so a future dependency bump on the TS side (or a
    pattern edit here) could silently reopen the gap.
    """
    base = {"tier": "L1", "composedBy": "composer", "cache": "miss"}
    with pytest.raises(ValidationError):
        Provenance.model_validate({**base, "composedAt": "2026-01-01T00:00Z"})
    Provenance.model_validate({**base, "composedAt": "2026-01-01T00:00:00Z"})


def test_provenance_generator_version_and_kit() -> None:
    """Mirrors the TS side's provenance.test.ts (Task 3, M-1/M-2): generatorVersion and kit ({id, version})
    are both optional, round-trip when present, and kit requires both id and version once given."""
    base = {"tier": "L1", "composedBy": "composer", "cache": "miss"}

    neither = Provenance.model_validate(base)
    assert neither.generatorVersion is None
    assert neither.kit is None

    with_gen = Provenance.model_validate({**base, "generatorVersion": "p12/gpt-5"})
    assert with_gen.generatorVersion == "p12/gpt-5"

    with_kit = Provenance.model_validate({**base, "kit": {"id": "kohaku", "version": "1"}})
    assert with_kit.kit is not None
    assert with_kit.kit.to_wire() == {"id": "kohaku", "version": "1"}

    with pytest.raises(ValidationError):
        Provenance.model_validate({**base, "kit": {"id": "kohaku"}})

    both = Provenance.model_validate(
        {**base, "generatorVersion": "p12/gpt-5", "kit": {"id": "acme", "version": "3"}}
    )
    assert both.to_wire()["generatorVersion"] == "p12/gpt-5"
    assert both.to_wire()["kit"] == {"id": "acme", "version": "3"}


def test_artifact_exactly_one_of_inline_uri() -> None:
    sha = "0" * 64
    SandboxArtifactRef.model_validate({"inline": "<html/>", "sha256": sha})
    SandboxArtifactRef.model_validate({"uri": "https://x/y", "sha256": sha})
    with pytest.raises(ValidationError):
        SandboxArtifactRef.model_validate({"sha256": sha})
    with pytest.raises(ValidationError):
        SandboxArtifactRef.model_validate({"inline": "a", "uri": "b", "sha256": sha})


class TestLeafPredicate:
    def test_exactly_one_comparison(self) -> None:
        LeafPredicate.model_validate({"ref": "$state.a", "eq": 1})
        with pytest.raises(ValidationError):
            LeafPredicate.model_validate({"ref": "$state.a"})
        with pytest.raises(ValidationError):
            LeafPredicate.model_validate({"ref": "$state.a", "eq": 1, "ne": 2})

    def test_eq_null_counts_as_specified(self) -> None:
        """eq: null is a valid comparison (distinguished from unspecified)."""
        leaf = LeafPredicate.model_validate({"ref": "$state.a", "eq": None})
        assert leaf.to_wire() == {"ref": "$state.a", "eq": None}

    def test_unknown_key_rejected(self) -> None:
        with pytest.raises(ValidationError):
            LeafPredicate.model_validate({"ref": "$state.a", "eq": 1, "extra": True})


def test_visible_when_depth_limit() -> None:
    """Nesting deeper than 8 is rejected (MAX_PREDICATE_DEPTH)."""
    pred: dict[str, Any] = {"ref": "$state.a", "eq": 1}
    for _ in range(7):  # depth 8 (leaf=1 + not×7) is OK
        pred = {"not": pred}
    ComponentNode.model_validate({"id": "a", "type": "x", "visibleWhen": pred})
    with pytest.raises(ValidationError):
        ComponentNode.model_validate({"id": "a", "type": "x", "visibleWhen": {"not": pred}})


def test_version_feature_requires_02(example_spec_data: dict[str, Any]) -> None:
    """Putting state on a 0.1 Spec yields VERSION_FEATURE_MISMATCH (via validate)."""
    from kohaku.spec import SpecParseFailed, safe_parse_spec

    data = {
        "kohaku": "0.1",
        "intent": example_spec_data["intent"],
        "dataVersion": "v1",
        "state": {"tab": "a"},
        "components": [{"id": "root", "type": "x"}],
        "provenance": {"tier": "L0", "composedBy": "t", "cache": "miss"},
    }
    result = safe_parse_spec(data)
    assert isinstance(result, SpecParseFailed)
    assert any(i.code == "VERSION_FEATURE_MISMATCH" for i in result.issues)
