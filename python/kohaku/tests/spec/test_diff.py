"""Tests for diff_spec / apply_patch / order_components."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from kohaku.spec import (
    SpecError,
    UISpec,
    apply_patch,
    canonical_stringify,
    diff_spec,
    order_components,
    parse_spec,
)


def _spec(data: dict[str, Any]) -> UISpec:
    return parse_spec(data)


def test_diff_apply_round_trip(example_spec_data: dict[str, Any]) -> None:
    """If prev is in canonical order, apply_patch(prev, diff_spec(prev, next)) == next."""
    prev = _spec(example_spec_data)

    next_data = copy.deepcopy(example_spec_data)
    next_data["components"][1]["props"]["text"] = "Updated title"
    next_data["components"].append({"id": "extra", "type": "presentMarkdown", "props": {}})
    next_data["components"][0]["children"].append("extra")
    next_data["dataVersion"] = "ledger@2026-07-01T00:00:00Z"
    next_spec = _spec(next_data)

    patch = diff_spec(prev, next_spec)
    applied = apply_patch(prev, patch)
    assert canonical_stringify(applied.to_wire()) == canonical_stringify(next_spec.to_wire())


def test_diff_no_change_is_minimal(example_spec_data: dict[str, Any]) -> None:
    prev = _spec(example_spec_data)
    patch = diff_spec(prev, prev)
    wire = patch.to_wire()
    assert set(wire.keys()) == {"baseIntentHash"}


def test_diff_remove(example_spec_data: dict[str, Any]) -> None:
    prev = _spec(example_spec_data)
    next_data = copy.deepcopy(example_spec_data)
    next_data["components"] = [c for c in next_data["components"] if c["id"] != "table1"]
    next_data["components"][0]["children"] = ["title", "chart1"]
    next_data["events"] = []
    next_spec = _spec(next_data)

    patch = diff_spec(prev, next_spec)
    assert patch.remove == ["table1"]
    applied = apply_patch(prev, patch)
    assert canonical_stringify(applied.to_wire()) == canonical_stringify(next_spec.to_wire())


def test_ref_versions_tri_state(example_spec_data: dict[str, Any]) -> None:
    """refVersions: no change (no key) / removal (null) / full replacement (dict)."""
    with_versions = copy.deepcopy(example_spec_data)
    with_versions["refVersions"] = {"query://a/b": "v1"}
    prev = _spec(with_versions)

    # Removal: next has no refVersions → the patch instructs null
    next_spec = _spec(example_spec_data)
    patch = diff_spec(prev, next_spec)
    assert patch.is_field_set("refVersions") and patch.refVersions is None
    assert patch.to_wire()["refVersions"] is None
    applied = apply_patch(prev, patch)
    assert applied.refVersions is None

    # No change: the patch has no key → keep prev's refVersions
    patch2 = diff_spec(next_spec, next_spec)
    assert not patch2.is_field_set("refVersions")
    applied2 = apply_patch(prev, patch2)
    assert applied2.refVersions == {"query://a/b": "v1"}


def test_apply_patch_base_mismatch(example_spec_data: dict[str, Any]) -> None:
    prev = _spec(example_spec_data)
    patch = diff_spec(prev, prev)
    bad = patch.model_copy(update={"baseIntentHash": "sha256:" + "f" * 64})
    with pytest.raises(SpecError) as e:
        apply_patch(prev, bad)
    assert e.value.code == "PATCH_BASE_MISMATCH"


def test_apply_patch_structural_failure(example_spec_data: dict[str, Any]) -> None:
    """A patch that removes root results in PATCH_APPLY_FAILED at post-apply validation."""
    from kohaku.spec import SpecPatch

    prev = _spec(example_spec_data)
    patch = SpecPatch.model_validate(
        {"baseIntentHash": prev.intent.hash, "remove": ["root"]}
    )
    with pytest.raises(SpecError) as e:
        apply_patch(prev, patch)
    assert e.value.code == "PATCH_APPLY_FAILED"


def test_order_components_dfs_then_orphans(example_spec_data: dict[str, Any]) -> None:
    """Root-first DFS order; unreachable components sorted by id at the end."""
    spec = _spec(example_spec_data)
    shuffled = list(reversed(spec.components))
    ordered = order_components(shuffled)
    assert [c.id for c in ordered] == ["root", "title", "chart1", "table1"]


def test_diff_apply_round_trip_version_upgrade_with_state(example_spec_data: dict[str, Any]) -> None:
    """A 0.1 -> 0.2 patch that also introduces `state` carries the version change (SPEC-PATCH-001)."""
    prev_data = copy.deepcopy(example_spec_data)
    prev_data["kohaku"] = "0.1"
    prev_data.pop("state", None)
    prev = _spec(prev_data)

    next_data = copy.deepcopy(prev_data)
    next_data["kohaku"] = "0.2"
    next_data["state"] = {"region": "japan"}
    next_spec = _spec(next_data)

    patch = diff_spec(prev, next_spec)
    assert patch.kohaku == "0.2"
    assert patch.state == {"region": "japan"}
    # Without patch.kohaku, applying against prev would keep "0.1" while adding `state`, which the
    # structural feature gate rejects as VERSION_FEATURE_MISMATCH.
    applied = apply_patch(prev, patch)
    assert canonical_stringify(applied.to_wire()) == canonical_stringify(next_spec.to_wire())


def test_diff_apply_round_trip_version_downgrade(example_spec_data: dict[str, Any]) -> None:
    prev_data = copy.deepcopy(example_spec_data)
    prev_data["kohaku"] = "0.2"
    prev_data.pop("state", None)
    prev = _spec(prev_data)
    next_data = copy.deepcopy(prev_data)
    next_data["kohaku"] = "0.1"
    next_spec = _spec(next_data)

    patch = diff_spec(prev, next_spec)
    assert patch.kohaku == "0.1"
    applied = apply_patch(prev, patch)
    assert canonical_stringify(applied.to_wire()) == canonical_stringify(next_spec.to_wire())


def test_diff_omits_kohaku_when_unchanged(example_spec_data: dict[str, Any]) -> None:
    prev = _spec(example_spec_data)
    assert "kohaku" not in diff_spec(prev, prev).to_wire()


def test_diff_to_wire_carries_kohaku_version_change(example_spec_data: dict[str, Any]) -> None:
    """to_wire() must carry the version change through the wire (e.g. an SSE `patch` event), not just
    the in-memory patch object: a prev 0.1 -> next 0.2 diff, serialized then reparsed, still upgrades."""
    from kohaku.spec import parse_patch

    prev_data = copy.deepcopy(example_spec_data)
    prev_data["kohaku"] = "0.1"
    prev_data.pop("state", None)
    prev = _spec(prev_data)

    next_data = copy.deepcopy(prev_data)
    next_data["kohaku"] = "0.2"
    next_spec = _spec(next_data)

    patch = diff_spec(prev, next_spec)
    wire = patch.to_wire()
    assert wire["kohaku"] == "0.2"

    reparsed = parse_patch(wire)
    applied = apply_patch(prev, reparsed)
    assert applied.kohaku == "0.2"
