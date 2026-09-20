"""Tests for policy_fingerprint (port of TS composer/context.ts's policyFingerprint).

A pytest port of the main scenarios of packages/composer/test/policy-fingerprint.test.ts.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from kohaku.composer import (
    DEFAULT_KIT_VOCABULARY,
    ComposePolicy,
    DesignKitVocabulary,
    DesignSystemGuide,
    EffortPolicy,
    FewShotPolicy,
    TierLlmFingerprintMaterial,
    TierModelIdentity,
    compose,
    policy_fingerprint,
)
from kohaku.llm import FakeLlm
from kohaku.spec import Intent
from kohaku.storage import FileStoragePort

from .test_compose import _INTENT_INPUT, _ctx, _l1_draft

_HEX16_RE = re.compile(r"^[0-9a-f]{16}$")


async def _empty_examples(intent: Intent) -> list[Any]:
    return []


def _select_components_with_id(intent: Intent, catalog: Any) -> list[str] | None:
    return None


_select_components_with_id.id = "narrow-v1"  # type: ignore[attr-defined]


class TestPolicyFingerprintCharacterization:
    """Pins the exact fingerprint bytes produced by the pre-refactor implementation (table-driven
    refactor of policy_fingerprint, H15). These three literals were computed against the
    implementation as it stood before the refactor and must never change — the refactor
    (Step 2) is only allowed to reshape *how* the fingerprint is computed, never *what* it
    computes. Do not regenerate these values from the new code; if any of them would need to
    change, the refactor is not behaviour-preserving and must stop."""

    def test_pinned_all_default_policy(self) -> None:
        """(a) An all-default policy fingerprints as the empty string."""
        assert policy_fingerprint(ComposePolicy()) == ""

    def test_pinned_output_language_only(self) -> None:
        """(b) A policy with only outputLanguage set."""
        assert policy_fingerprint(ComposePolicy(outputLanguage="Japanese")) == "51b1deb410b1f29c"

    def test_pinned_every_fingerprinted_field_set(self) -> None:
        """(c) A policy with every fingerprinted field set (including tier_llm material)."""
        policy = ComposePolicy(
            outputLanguage="Japanese",
            designSystem=DesignSystemGuide(
                tokens={"color.primary": "custom primary"},
                guidelines=["be concise", "use tokens"],
                enforceTokenColors=False,
            ),
            fewShot=FewShotPolicy(examples=_empty_examples, id="v2"),
            selectComponents=_select_components_with_id,
            refConstraint="validate",
            effort=EffortPolicy(l1="high", l2="low"),
        )
        tier_llm = TierLlmFingerprintMaterial(
            l1=TierModelIdentity(provider="openai", model_id="gpt-4"),
            l2=TierModelIdentity(provider="anthropic", model_id="claude-3"),
        )
        assert policy_fingerprint(policy, tier_llm) == "4d9163508504fc99"


class TestPolicyFingerprint:
    def test_empty_string_when_nothing_set(self) -> None:
        assert policy_fingerprint(ComposePolicy()) == ""
        assert policy_fingerprint(ComposePolicy(cacheMode="bypass", allowL2=True, maxRepairAttempts=2)) == ""

    def test_16_hex_once_a_field_is_set(self) -> None:
        pf = policy_fingerprint(ComposePolicy(outputLanguage="Japanese"))
        assert _HEX16_RE.match(pf) is not None

    def test_ref_constraint_default_schema_is_the_empty_string(self) -> None:
        """Unset and explicit "schema" (the default) must fingerprint identically to unset — no cache-key
        perturbation for existing callers (port of the TS refConstraint fingerprint test)."""
        assert policy_fingerprint(ComposePolicy()) == policy_fingerprint(ComposePolicy(refConstraint="schema"))
        assert policy_fingerprint(ComposePolicy(refConstraint="schema")) == ""

    def test_ref_constraint_validate_changes_the_fingerprint(self) -> None:
        schema_fp = policy_fingerprint(ComposePolicy(refConstraint="schema"))
        validate_fp = policy_fingerprint(ComposePolicy(refConstraint="validate"))
        assert validate_fp != schema_fp
        assert _HEX16_RE.match(validate_fp) is not None

    def test_deterministic(self) -> None:
        a = policy_fingerprint(
            ComposePolicy(outputLanguage="Japanese", designSystem=DesignSystemGuide(guidelines=["x"]))
        )
        b = policy_fingerprint(
            ComposePolicy(outputLanguage="Japanese", designSystem=DesignSystemGuide(guidelines=["x"]))
        )
        assert a == b

    def test_differs_by_output_language(self) -> None:
        en = policy_fingerprint(ComposePolicy(outputLanguage="English"))
        ja = policy_fingerprint(ComposePolicy(outputLanguage="Japanese"))
        assert en != ja

    def test_differs_by_design_system_body(self) -> None:
        a = policy_fingerprint(ComposePolicy(designSystem=DesignSystemGuide(guidelines=["a"])))
        b = policy_fingerprint(ComposePolicy(designSystem=DesignSystemGuide(guidelines=["b"])))
        assert a != b

    def test_few_shot_without_id_fingerprints_as_anonymous(self) -> None:
        a = policy_fingerprint(ComposePolicy(fewShot=FewShotPolicy(examples=_empty_examples)))
        b = policy_fingerprint(ComposePolicy(fewShot=FewShotPolicy(examples=_empty_examples, maxExamples=5)))
        assert a == b  # maxExamples does not participate — only the id (or its "anonymous" default)

    def test_few_shot_id_changes_fingerprint(self) -> None:
        anonymous = policy_fingerprint(ComposePolicy(fewShot=FewShotPolicy(examples=_empty_examples)))
        named = policy_fingerprint(
            ComposePolicy(fewShot=FewShotPolicy(examples=_empty_examples, id="v2"))
        )
        assert anonymous != named

    def test_select_components_id_changes_fingerprint(self) -> None:
        def bare(intent: Intent, catalog: Any) -> list[str] | None:
            return None

        def with_id(intent: Intent, catalog: Any) -> list[str] | None:
            return None

        with_id.id = "narrow-v1"  # type: ignore[attr-defined]

        bare_fp = policy_fingerprint(ComposePolicy(selectComponents=bare))
        id_fp = policy_fingerprint(ComposePolicy(selectComponents=with_id))
        assert bare_fp != id_fp

    def test_cache_key_unchanged_when_no_fingerprinted_field_set(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage = FileStoragePort(tmp_path)
            llm = FakeLlm(objects=[_l1_draft()])
            ctx = _ctx(llm, storage, ComposePolicy(generatorVersion="gv1"))
            result = await compose(_INTENT_INPUT, ctx)
            assert result.trace.cacheKey.endswith(":gv1")

        asyncio.run(run())

    def test_cache_key_changes_once_a_fingerprinted_field_is_set(self, tmp_path: Any) -> None:
        async def run() -> None:
            storage1 = FileStoragePort(tmp_path / "a")
            bare_ctx = _ctx(FakeLlm(objects=[_l1_draft()]), storage1, ComposePolicy(generatorVersion="gv1"))
            bare = await compose(_INTENT_INPUT, bare_ctx)

            storage2 = FileStoragePort(tmp_path / "b")
            ja_ctx = _ctx(
                FakeLlm(objects=[_l1_draft()]),
                storage2,
                ComposePolicy(generatorVersion="gv1", outputLanguage="Japanese"),
            )
            with_output_language = await compose(_INTENT_INPUT, ja_ctx)

            assert bare.trace.cacheKey != with_output_language.trace.cacheKey

        asyncio.run(run())


class TestDesignKitFingerprint:
    """Task 7b/10 mirror: designSystem.kit / enforceKitClasses must be visible to policy_fingerprint (they
    were previously invisible to the cache key). The TS-side pair is the same-named `it` blocks in
    packages/composer/test/policy-fingerprint.test.ts."""

    def test_kit_changes_the_fingerprint(self) -> None:
        without_kit = policy_fingerprint(
            ComposePolicy(designSystem=DesignSystemGuide(tokens={"color.primary": "brand color"}))
        )
        with_kit = policy_fingerprint(
            ComposePolicy(
                designSystem=DesignSystemGuide(
                    tokens={"color.primary": "brand color"}, kit=DEFAULT_KIT_VOCABULARY
                )
            )
        )
        assert with_kit != without_kit

    def test_two_kits_differing_only_in_version_produce_different_fingerprints(self) -> None:
        kit_v2 = DesignKitVocabulary(
            id=DEFAULT_KIT_VOCABULARY.id,
            version="2",
            classes=DEFAULT_KIT_VOCABULARY.classes,
            utilities=DEFAULT_KIT_VOCABULARY.utilities,
            namespaces=DEFAULT_KIT_VOCABULARY.namespaces,
            skeleton=DEFAULT_KIT_VOCABULARY.skeleton,
        )
        fp_v1 = policy_fingerprint(ComposePolicy(designSystem=DesignSystemGuide(kit=DEFAULT_KIT_VOCABULARY)))
        fp_v2 = policy_fingerprint(ComposePolicy(designSystem=DesignSystemGuide(kit=kit_v2)))
        assert fp_v1 != fp_v2

    def test_enforce_kit_classes_false_differs_true_is_indistinguishable_from_unset(self) -> None:
        unset = policy_fingerprint(ComposePolicy(designSystem=DesignSystemGuide(kit=DEFAULT_KIT_VOCABULARY)))
        explicit_true = policy_fingerprint(
            ComposePolicy(designSystem=DesignSystemGuide(kit=DEFAULT_KIT_VOCABULARY, enforceKitClasses=True))
        )
        explicit_false = policy_fingerprint(
            ComposePolicy(designSystem=DesignSystemGuide(kit=DEFAULT_KIT_VOCABULARY, enforceKitClasses=False))
        )
        assert explicit_true == unset
        assert explicit_false != unset

    def test_kit_less_design_system_fingerprint_is_unchanged(self) -> None:
        """Pinned against the value produced BEFORE kit / enforceKitClasses joined the material (computed
        with `uv run python -c "..."` against the pre-Task-10 policy_fingerprint).

        If this changes, the new keys are being serialized (even as null) for policies that do not use
        them, which silently invalidates every existing design-system consumer's compose cache. If this
        goes red, fix the material so the new key is absent by default (UNDEFINED, not None) — never
        update this expected value. Re-pinning it is how the guarantee is lost. (The TS-side pin is a
        different literal value — "a88d021f77ce79fd" — because Python's fingerprint is deterministic and
        reproducible but not cross-language-pinned: it is not required to byte-match TS's for an
        equivalent policy; see policy_fingerprint's own docstring.)
        """
        assert (
            policy_fingerprint(
                ComposePolicy(
                    designSystem=DesignSystemGuide(tokens={"color.primary": "brand"}, guidelines=["a"])
                )
            )
            == "65df86e493a4cb0c"
        )
