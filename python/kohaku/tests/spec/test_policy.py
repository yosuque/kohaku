"""Unit tests for kohaku.spec.policy (port of packages/spec-core/test/policy.test.ts's in-memory half;
the file-based accept/reject coverage lives in test_policy_examples.py)."""

from __future__ import annotations

from pydantic import ValidationError

from kohaku.spec.policy import KohakuPolicyFile, compute_policy_id, merge_policy_sections


def test_accepts_the_minimal_shape() -> None:
    KohakuPolicyFile.model_validate({"version": 1, "defaults": {}})


def test_accepts_a_fully_populated_section() -> None:
    KohakuPolicyFile.model_validate(
        {
            "version": 1,
            "label": "demo",
            "defaults": {
                "compose": {
                    "allowL2": True,
                    "maxRepairAttempts": 1,
                    "refConstraint": "validate",
                    "effort": {"l1": "low", "l2": "high"},
                    "outputLanguage": "English",
                    "cacheFailure": "closed",
                    "ttlSeconds": 60,
                    "budget": {
                        "perCompose": {"stopAfterTokens": 1000},
                        "deadlineMs": 5000,
                        "dailyTokens": 100000,
                    },
                },
                "rateLimits": {
                    "compose": {"capacity": 10, "refillPerSecond": 1},
                    "action": {"capacity": 5, "refillPerSecond": 0.5},
                    "resolve": {"capacity": 20, "refillPerSecond": 2},
                },
                "governance": {"roles": {"admin": ["*"]}},
            },
            "tenants": {"tenant-a": {"compose": {"allowL2": False}}},
        }
    )


def test_rejects_a_version_other_than_1() -> None:
    try:
        KohakuPolicyFile.model_validate({"version": 2, "defaults": {}})
    except ValidationError:
        return
    raise AssertionError("expected ValidationError")


def test_rejects_an_unknown_top_level_key() -> None:
    try:
        KohakuPolicyFile.model_validate({"version": 1, "defaults": {}, "bogus": True})
    except ValidationError:
        return
    raise AssertionError("expected ValidationError")


def test_rejects_an_unknown_key_inside_defaults_compose() -> None:
    try:
        KohakuPolicyFile.model_validate(
            {"version": 1, "defaults": {"compose": {"allowL2": True, "bogus": 1}}}
        )
    except ValidationError:
        return
    raise AssertionError("expected ValidationError")


def test_rejects_a_negative_rate_limit_capacity() -> None:
    try:
        KohakuPolicyFile.model_validate(
            {"version": 1, "defaults": {"rateLimits": {"compose": {"capacity": -1, "refillPerSecond": 1}}}}
        )
    except ValidationError:
        return
    raise AssertionError("expected ValidationError")


def test_has_no_field_for_a_function_shaped_compose_policy_setting() -> None:
    try:
        KohakuPolicyFile.model_validate({"version": 1, "defaults": {"compose": {"routeTier": "L2"}}})
    except ValidationError:
        return
    raise AssertionError("expected ValidationError")


def test_merge_disjoint_top_level_keys_from_both_sides() -> None:
    base = {"compose": {"allowL2": True}}
    override = {"governance": {"roles": {"admin": ["*"]}}}
    assert merge_policy_sections(base, override) == {
        "compose": {"allowL2": True},
        "governance": {"roles": {"admin": ["*"]}},
    }


def test_merge_recurses_into_nested_objects_rather_than_replacing_the_whole_object() -> None:
    base = {"compose": {"allowL2": True, "budget": {"perCompose": {"stopAfterTokens": 20000}}}}
    override = {"compose": {"budget": {"dailyTokens": 1000}}}
    assert merge_policy_sections(base, override) == {
        "compose": {
            "allowL2": True,
            "budget": {"perCompose": {"stopAfterTokens": 20000}, "dailyTokens": 1000},
        }
    }


def test_merge_scalar_override_replaces_bases_value() -> None:
    assert merge_policy_sections({"compose": {"allowL2": False}}, {"compose": {"allowL2": True}}) == {
        "compose": {"allowL2": True}
    }


def test_merge_array_on_override_replaces_bases_array_wholesale() -> None:
    base = {"governance": {"roles": {"admin": ["lineage.read"]}}}
    override = {"governance": {"roles": {"admin": ["*"]}}}
    assert merge_policy_sections(base, override) == {"governance": {"roles": {"admin": ["*"]}}}


def test_merge_a_key_present_only_in_base_survives_an_unrelated_override() -> None:
    base = {"governance": {"roles": {"admin": ["*"], "viewer": ["lineage.read"]}}}
    override = {"governance": {"roles": {"viewer": ["lineage.read", "analytics.read"]}}}
    assert merge_policy_sections(base, override) == {
        "governance": {"roles": {"admin": ["*"], "viewer": ["lineage.read", "analytics.read"]}}
    }


def test_merge_empty_override_returns_bases_shape_unchanged() -> None:
    base = {"compose": {"allowL2": True}}
    assert merge_policy_sections(base, {}) == base


def test_compute_policy_id_is_deterministic_for_the_same_content() -> None:
    file = KohakuPolicyFile.model_validate({"version": 1, "defaults": {"compose": {"allowL2": True}}})
    assert compute_policy_id(file) == compute_policy_id(file)


def test_compute_policy_id_has_the_sha256_hex_shape() -> None:
    file = KohakuPolicyFile.model_validate({"version": 1, "defaults": {}})
    policy_id = compute_policy_id(file)
    assert policy_id.startswith("sha256:")
    assert len(policy_id) == len("sha256:") + 64


def test_compute_policy_id_differs_when_the_content_differs() -> None:
    a = KohakuPolicyFile.model_validate({"version": 1, "defaults": {"compose": {"allowL2": True}}})
    b = KohakuPolicyFile.model_validate({"version": 1, "defaults": {"compose": {"allowL2": False}}})
    assert compute_policy_id(a) != compute_policy_id(b)


def test_compute_policy_id_is_unaffected_by_source_key_order() -> None:
    a = KohakuPolicyFile.model_validate(
        {"version": 1, "defaults": {"compose": {"allowL2": True, "maxRepairAttempts": 2}}}
    )
    b = KohakuPolicyFile.model_validate(
        {"version": 1, "defaults": {"compose": {"maxRepairAttempts": 2, "allowL2": True}}}
    )
    assert compute_policy_id(a) == compute_policy_id(b)
