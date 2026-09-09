"""Tests for ComposePolicy.refConstraint ("schema" | "validate") — port of the TS-side
packages/composer/test/ref-constraint.test.ts.
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import ComposePolicy, ResolvedRefs, compose
from kohaku.composer.l1_generate import build_l1_generation_schema
from kohaku.llm import FakeLlm
from kohaku.spec import Intent
from kohaku.storage import FileStoragePort

from .test_compose import _INTENT_INPUT, _REF, _ctx, _l1_draft


def _refs() -> ResolvedRefs:
    return ResolvedRefs(handles=[], uris=[_REF], shapesByRef={}, dataVersion="v1", versionsByRef={})


def _draft_with_ref(ref: str) -> dict[str, Any]:
    draft = _l1_draft()
    draft["components"][2]["data"] = {"$ref": ref}
    return draft


def _data_ref_schemas(json_schema: Any) -> list[Any]:
    """Collects every `properties.$ref` schema found anywhere in the generation schema (regardless of which
    shape it is wrapped in), matching the TS test's traversal."""
    found: list[Any] = []

    def visit(node: object) -> None:
        if isinstance(node, list):
            for item in node:
                visit(item)
            return
        if not isinstance(node, dict):
            return
        ref_value = node.get("$ref")
        if isinstance(ref_value, dict):
            found.append(ref_value)
        for value in node.values():
            visit(value)

    visit(json_schema)
    return found


_INTENT = Intent(canonical="sales.summary", params={"fy": 2026}, hash="sha256:" + "0" * 64)


class TestRefConstraintSchemaStage:
    def test_default_schema_pins_data_ref_to_an_enum(self, tmp_path: Any) -> None:
        ctx = _ctx(FakeLlm(objects=[_l1_draft()]), FileStoragePort(tmp_path), ComposePolicy())
        generation = build_l1_generation_schema(ctx, _refs(), None)
        ref_schemas = _data_ref_schemas(generation.jsonSchema)
        assert len(ref_schemas) > 0
        for s in ref_schemas:
            assert s == {"type": "string", "enum": [_REF]}

    def test_validate_relaxes_data_ref_to_a_plain_string(self, tmp_path: Any) -> None:
        ctx = _ctx(
            FakeLlm(objects=[_l1_draft()]),
            FileStoragePort(tmp_path),
            ComposePolicy(refConstraint="validate"),
        )
        generation = build_l1_generation_schema(ctx, _refs(), None)
        ref_schemas = _data_ref_schemas(generation.jsonSchema)
        assert len(ref_schemas) > 0
        for s in ref_schemas:
            assert s == {"type": "string"}


class TestRefConstraintValidation:
    def test_validate_mode_flags_out_of_set_ref_as_data_ref_unresolved(self, tmp_path: Any) -> None:
        async def run() -> None:
            evil = "query://sales/evil?fy=2026"
            llm = FakeLlm(objects=[_draft_with_ref(evil), _l1_draft()])
            ctx = _ctx(llm, FileStoragePort(tmp_path), ComposePolicy(refConstraint="validate"))
            result = await compose(_INTENT_INPUT, ctx)

            assert len(result.trace.attempts) == 2
            assert result.trace.attempts[0].ok is False
            issues = " ".join(result.trace.attempts[0].issues or [])
            assert "DATA_REF_UNRESOLVED" in issues
            assert "INVALID_REF" not in issues
            assert evil in issues
            assert result.trace.attempts[1].ok is True

        asyncio.run(run())

    def test_default_schema_mode_still_flags_out_of_set_ref_as_invalid_ref(self, tmp_path: Any) -> None:
        async def run() -> None:
            evil = "query://sales/evil?fy=2026"
            llm = FakeLlm(objects=[_draft_with_ref(evil), _l1_draft()])
            ctx = _ctx(llm, FileStoragePort(tmp_path), ComposePolicy())
            result = await compose(_INTENT_INPUT, ctx)

            issues = " ".join(result.trace.attempts[0].issues or [])
            assert "INVALID_REF" in issues
            assert "DATA_REF_UNRESOLVED" not in issues

        asyncio.run(run())

    def test_validate_mode_repair_exhaustion_falls_back_deterministically_with_identifiable_cause(
        self, tmp_path: Any
    ) -> None:
        """Port of the TS-side repair-exhaustion test added to ref-constraint.test.ts: unlike the
        "repair succeeds on the 2nd attempt" test above, every attempt here (initial + the one default
        repair retry) returns the same out-of-set $ref, so the repair loop can never validate and compose
        must fall back deterministically instead of looping forever or raising.
        """

        async def run() -> None:
            evil = "query://sales/evil?fy=2026"
            # Default maxRepairAttempts=1 => 2 total attempts; both return the evil ref.
            llm = FakeLlm(objects=[_draft_with_ref(evil), _draft_with_ref(evil)])
            ctx = _ctx(llm, FileStoragePort(tmp_path), ComposePolicy(refConstraint="validate"))
            result = await compose(_INTENT_INPUT, ctx)

            # allowL2 defaults to False, so an exhausted "invalid" L1 failure settles as a deterministic
            # fallback rather than promoting to L2 (mirrors TS's tier-ladder.py settle_l1_failure).
            assert result.trace.tier == "L1"
            assert result.trace.fallback_reason is not None
            assert result.spec.provenance.fallback is not None

            # Every attempt was exhausted (none ok), and each one's issues name the unresolved-reference
            # cause — DATA_REF_UNRESOLVED (not INVALID_REF, since refConstraint is "validate") together
            # with the actual out-of-set URI — so the cause is identifiable from the trace even though the
            # top-level fallback_reason string itself is a generic, cause-agnostic message.
            assert len(result.trace.attempts) == 2
            for attempt in result.trace.attempts:
                assert attempt.ok is False
                issues = " ".join(attempt.issues or [])
                assert "DATA_REF_UNRESOLVED" in issues
                assert "INVALID_REF" not in issues
                assert evil in issues

        asyncio.run(run())
