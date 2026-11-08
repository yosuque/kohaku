"""Cross-language golden for composer's L1 filter injection (Python side).

Reproduces the `l1Filters` section of spec/test/fixtures/cross-language-canonical.json, which the TS
implementation generates (the TS counterpart is spec/test/cross-language.test.ts; the inputs live in
spec/test/l1-filters-cases.ts and are carried inside the fixture itself, so only the outputs are TS-computed).
"""

from __future__ import annotations

from typing import Any

from kohaku.composer import ComposePolicy, EffortPolicy, inject_filters, policy_fingerprint
from kohaku.composer.context import filter_descriptors_hash
from kohaku.spec import FilterDescriptor, FilterOption, UISpec, canonical_stringify


def _descriptor(wire: dict[str, Any]) -> FilterDescriptor:
    return FilterDescriptor(
        param=wire["param"],
        queryParam=wire["queryParam"],
        paths=list(wire["paths"]),
        label=wire["label"],
        options=[FilterOption(o["value"], o["label"]) for o in wire["options"]],
    )


def test_inject_filters_reproduces_the_fixture_byte_for_byte(
    cross_language_fixture: dict[str, Any],
) -> None:
    cases = cross_language_fixture["l1Filters"]["inject"]
    assert cases
    for case in cases:
        out = inject_filters(
            UISpec.model_validate(case["spec"]),
            [_descriptor(d) for d in case["descriptors"]],
            max_variants=case.get("maxVariants"),
        )
        expected = case["expected"]
        assert out.injected == expected["injected"], case["name"]
        assert out.skipped == expected.get("skipped"), case["name"]
        assert canonical_stringify(out.spec.to_wire()) == canonical_stringify(expected["spec"]), (
            case["name"]
        )


def _policy(wire: dict[str, Any]) -> ComposePolicy:
    effort = wire.get("effort")
    return ComposePolicy(
        outputLanguage=wire.get("outputLanguage"),
        refConstraint=wire.get("refConstraint", "schema"),
        allowL2=wire.get("allowL2", False),
        effort=EffortPolicy(l1=effort.get("l1"), l2=effort.get("l2"))
        if effort is not None
        else None,
        l1Filters=wire.get("l1Filters", False),
        l1FiltersMaxVariants=wire.get("l1FiltersMaxVariants"),
    )


def test_policy_fingerprint_reproduces_the_fixture(cross_language_fixture: dict[str, Any]) -> None:
    cases = cross_language_fixture["l1Filters"]["policyFingerprint"]
    assert cases
    for case in cases:
        descriptors = (
            [_descriptor(d) for d in case["descriptors"]] if "descriptors" in case else None
        )
        descriptors_hash = filter_descriptors_hash(descriptors)
        if descriptors is not None:
            assert descriptors_hash == case["descriptorsHash"], case["name"]
        assert (
            policy_fingerprint(_policy(case["policy"]), None, descriptors_hash)
            == case["fingerprint"]
        ), case["name"]
    by_name = {c["name"]: c["fingerprint"] for c in cases}
    # l1Filters:false is indistinguishable from unset.
    assert by_name["l1Filters false is the default"] == by_name["empty policy"]
    assert by_name["l1Filters true"] != by_name["empty policy"]
    # The default cap and a policy-off descriptor list contribute nothing; a changed cap / descriptors / label does.
    assert by_name["l1FiltersMaxVariants 64 is the default"] == by_name["l1Filters true"]
    assert by_name["l1FiltersMaxVariants without l1Filters is ignored"] == by_name["empty policy"]
    assert by_name["l1Filters false ignores descriptors"] == by_name["empty policy"]
    distinct = [
        by_name[n]
        for n in (
            "l1Filters true",
            "l1FiltersMaxVariants 32",
            "l1Filters true with descriptors",
            "l1Filters true with other descriptors",
            "l1Filters true with the same options relabelled",
        )
    ]
    assert len(set(distinct)) == len(distinct)
