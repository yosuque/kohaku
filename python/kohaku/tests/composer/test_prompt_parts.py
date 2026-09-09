"""Tests for opt-in prompt caching plumbing (PromptParts) — port of the TS-side
packages/composer/test/l1-prompt-memo.test.ts's promptParts assertions and an L2 analogue.
"""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import (
    ComposeContext,
    ComposePolicy,
    build_l1_prompt,
    build_l1_prompt_parts,
    build_l1_prompt_static,
    build_l2_prompt,
    build_l2_prompt_parts,
    build_l2_prompt_static,
    compose,
)
from kohaku.llm import (
    GenerateObjectRequest,
    GenerateObjectResult,
    GenerateTextRequest,
    GenerateTextResult,
    LlmUsage,
)
from kohaku.spec import Intent
from kohaku.storage import FileStoragePort

from .test_compose import _CATALOG, _INTENT_INPUT, _FakeSemantic, _l1_draft

_BASE_ARGS: dict[str, Any] = {
    "intent": Intent(canonical="x.y", params={}, hash="sha256:" + "0" * 64),
}


class TestBuildL1PromptParts:
    def test_no_repair_feedback_cacheable_is_the_whole_prompt_and_rest_is_empty(self) -> None:
        from kohaku.registry import core_catalog, resolve_catalog

        catalog = resolve_catalog(core_catalog())
        parts = build_l1_prompt_parts(
            intent=_BASE_ARGS["intent"],
            catalog=catalog,
            refs=["query://sales/summary?fy=2026"],
            shapes_by_ref={},
        )
        expected = build_l1_prompt(
            intent=_BASE_ARGS["intent"],
            catalog=catalog,
            refs=["query://sales/summary?fy=2026"],
            shapes_by_ref={},
        )
        assert parts.cacheable + parts.rest == expected
        assert parts.cacheable == build_l1_prompt_static(
            intent=_BASE_ARGS["intent"],
            catalog=catalog,
            refs=["query://sales/summary?fy=2026"],
            shapes_by_ref={},
        )
        assert parts.rest == ""

    def test_with_repair_feedback_cacheable_stays_static_and_rest_carries_only_feedback(self) -> None:
        from kohaku.registry import core_catalog, resolve_catalog

        catalog = resolve_catalog(core_catalog())
        feedback = ["components is empty"]
        parts = build_l1_prompt_parts(
            intent=_BASE_ARGS["intent"],
            catalog=catalog,
            refs=["query://sales/summary?fy=2026"],
            shapes_by_ref={},
            repair_feedback=feedback,
        )
        expected = build_l1_prompt(
            intent=_BASE_ARGS["intent"],
            catalog=catalog,
            refs=["query://sales/summary?fy=2026"],
            shapes_by_ref={},
            repair_feedback=feedback,
        )
        assert parts.cacheable + parts.rest == expected
        assert "## Problems in the previous generation" in parts.rest


class TestBuildL2PromptParts:
    def test_invariant_holds_with_and_without_repair_feedback(self) -> None:
        intent = Intent(canonical="x.y", params={}, hash="sha256:" + "0" * 64)
        for feedback in (None, ["L2_READY_MISSING: ..."]):
            parts = build_l2_prompt_parts(
                intent=intent, refs=["query://x"], shapes_by_ref={}, repair_feedback=feedback
            )
            expected = build_l2_prompt(
                intent=intent, refs=["query://x"], shapes_by_ref={}, repair_feedback=feedback
            )
            assert parts.cacheable + parts.rest == expected
            assert parts.cacheable == build_l2_prompt_static(intent=intent, refs=["query://x"], shapes_by_ref={})


class _CaptureLlm:
    """A minimal LlmPort stub that records every generate_object call's prompt_parts."""

    provider = "capture"
    model_id = "capture-model"

    def __init__(self, objects: list[Any]) -> None:
        self._objects = list(objects)
        self.requests: list[GenerateObjectRequest] = []

    async def generate_object(self, req: GenerateObjectRequest) -> GenerateObjectResult:
        self.requests.append(req)
        obj = self._objects.pop(0)
        return GenerateObjectResult(object=obj, usage=LlmUsage(input_tokens=0, output_tokens=0), model=self.model_id)

    async def generate_text(self, req: GenerateTextRequest) -> GenerateTextResult:
        raise AssertionError("capture stub: generate_text not supported")


class TestGenerateL1PromptPartsAcrossRepairAttempts:
    def test_cacheable_prefix_is_identical_across_attempts_only_rest_differs(self, tmp_path: Any) -> None:
        async def run() -> None:
            bad: dict[str, Any] = {"components": [], "events": []}
            llm = _CaptureLlm([bad, _l1_draft()])
            ctx = ComposeContext(
                catalog=_CATALOG,
                semantic=_FakeSemantic(),
                storage=FileStoragePort(tmp_path),
                llm=llm,
                policy=ComposePolicy(),
            )
            result = await compose(_INTENT_INPUT, ctx)

            assert result.trace.tier == "L1"
            assert len(llm.requests) == 2
            first, second = llm.requests
            assert first.prompt_parts is not None
            assert second.prompt_parts is not None
            assert first.prompt_parts.cacheable == second.prompt_parts.cacheable
            assert first.prompt_parts.rest == ""
            assert "## Problems in the previous generation" in second.prompt_parts.rest
            assert first.prompt_parts.cacheable + first.prompt_parts.rest == first.prompt
            assert second.prompt_parts.cacheable + second.prompt_parts.rest == second.prompt

        asyncio.run(run())
