"""Tests for FakeLlm (the FakeLlm scenarios of llm.test.ts as pytest)."""

from __future__ import annotations

import asyncio

import pytest
from pydantic import BaseModel

from kohaku.llm import GenerateObjectRequest, JsonSchema, LlmError
from kohaku.llm.fake import FakeLlm, FakeLlmCall


class _A(BaseModel):
    a: int


def test_returns_scripted_objects_in_order_and_records_calls() -> None:
    async def run() -> None:
        fake = FakeLlm(objects=[{"a": 1}, {"a": 2}])
        r1 = await fake.generate_object(GenerateObjectRequest(schema=_A, prompt="p1"))
        r2 = await fake.generate_object(
            GenerateObjectRequest(schema=_A, prompt="p2", system="s")
        )
        assert r1.object == _A(a=1)
        assert r2.object == _A(a=2)
        assert fake.calls == [
            FakeLlmCall(kind="object", prompt="p1"),
            FakeLlmCall(kind="object", prompt="p2", system="s"),
        ]

    asyncio.run(run())


def test_scripted_response_not_matching_schema_is_invalid_output() -> None:
    async def run() -> None:
        fake = FakeLlm(objects=[{"a": "oops"}])
        with pytest.raises(LlmError, match="does not match schema") as exc:
            await fake.generate_object(GenerateObjectRequest(schema=_A, prompt="p"))
        assert exc.value.code == "INVALID_OUTPUT"

    asyncio.run(run())


def test_json_schema_input_passes_through_without_validation() -> None:
    async def run() -> None:
        fake = FakeLlm(objects=[{"anything": True}])
        r = await fake.generate_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")
        )
        assert r.object == {"anything": True}

    asyncio.run(run())


def test_object_index_does_not_advance_on_validation_failure() -> None:
    async def run() -> None:
        # Confirm the index does not advance on a validation failure (record/replay can re-consume the same response).
        fake = FakeLlm(objects=[{"a": "oops"}, {"a": 2}])
        with pytest.raises(LlmError):
            await fake.generate_object(GenerateObjectRequest(schema=_A, prompt="p1"))
        # With JsonSchema, the same (unconsumed) first element can be read without validation.
        r = await fake.generate_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p2")
        )
        assert r.object == {"a": "oops"}

    asyncio.run(run())


def test_exhausted_object_script_raises() -> None:
    async def run() -> None:
        fake = FakeLlm(objects=[])
        with pytest.raises(LlmError, match="no scripted object response left"):
            await fake.generate_object(
                GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p")
            )

    asyncio.run(run())


def test_scripted_texts_in_order() -> None:
    from kohaku.llm import GenerateTextRequest

    async def run() -> None:
        fake = FakeLlm(texts=["hello", "world"])
        r1 = await fake.generate_text(GenerateTextRequest(prompt="p1"))
        r2 = await fake.generate_text(GenerateTextRequest(prompt="p2", system="s"))
        assert r1.text == "hello"
        assert r2.text == "world"
        assert fake.calls == [
            FakeLlmCall(kind="text", prompt="p1"),
            FakeLlmCall(kind="text", prompt="p2", system="s"),
        ]
        with pytest.raises(LlmError, match="no scripted text response left"):
            await fake.generate_text(GenerateTextRequest(prompt="p3"))

    asyncio.run(run())


def test_stream_object_notifies_scripted_partials_then_returns_final() -> None:
    async def run() -> None:
        seen: list[object] = []
        fake = FakeLlm(
            objects=[{"components": ["done"]}],
            partials=[[{"components": []}, {"components": ["a"]}]],
        )
        result = await fake.stream_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p"),
            lambda partial: seen.append(partial),
        )
        # The cumulative partial sequence is notified in script order, and the final result matches generate_object.
        assert seen == [{"components": []}, {"components": ["a"]}]
        assert result.object == {"components": ["done"]}

    asyncio.run(run())


def test_stream_object_swallows_on_partial_exceptions() -> None:
    async def run() -> None:
        def _boom(_partial: object) -> None:
            raise RuntimeError("consumer exception")

        fake = FakeLlm(objects=[{"ok": True}], partials=[[{"x": 1}]])
        # A throw from on_partial is swallowed, and the final result returns normally (port contract).
        result = await fake.stream_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p"), _boom
        )
        assert result.object == {"ok": True}

    asyncio.run(run())


def test_stream_object_without_partials_is_equivalent_to_generate_object() -> None:
    async def run() -> None:
        seen: list[object] = []
        fake = FakeLlm(objects=[{"ok": 1}])
        result = await fake.stream_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="p"),
            lambda partial: seen.append(partial),
        )
        assert seen == []  # no partials specified means no notification at all (best-effort)
        assert result.object == {"ok": 1}

    asyncio.run(run())


def test_object_and_text_function_scripts() -> None:
    from kohaku.llm import GenerateTextRequest

    async def run() -> None:
        fake = FakeLlm(
            objects=lambda req: {"echo": req.prompt},
            texts=lambda req: f"text:{req.prompt}",
        )
        r = await fake.generate_object(
            GenerateObjectRequest(schema=JsonSchema({"type": "object"}), prompt="hi")
        )
        assert r.object == {"echo": "hi"}
        t = await fake.generate_text(GenerateTextRequest(prompt="yo"))
        assert t.text == "text:yo"

    asyncio.run(run())
