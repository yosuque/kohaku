"""Tests for FixtureLlm (record/replay).

There is no dedicated TS-side test, so the record→replay round trip, the key-format TS compatibility, and the
abnormal cases are checked on the Python side. No real LLM is used; a FakeLlm is placed inside to run record.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from kohaku.evals import FixtureLlm
from kohaku.llm import (
    FakeLlm,
    GenerateObjectRequest,
    GenerateTextRequest,
    JsonSchema,
    LlmError,
)
from kohaku.spec import sha256_hex


class _Shape(BaseModel):
    n: int


def test_record_then_replay_object_roundtrip(tmp_path: Path) -> None:
    async def run() -> None:
        live = FakeLlm(objects=[{"n": 7}])
        rec = FixtureLlm(tmp_path, record=True, live=live)
        result = await rec.generate_object(
            GenerateObjectRequest(schema=_Shape, schema_name="s", prompt="p")
        )
        assert result.object.n == 7
        assert result.model == "fake-model"  # the live's modelId passes through

        # Remove record when replaying. Read deterministically from the fixture and re-validate against the schema.
        rep = FixtureLlm(tmp_path)
        again = await rep.generate_object(
            GenerateObjectRequest(schema=_Shape, schema_name="s", prompt="p")
        )
        assert isinstance(again.object, _Shape)
        assert again.object.n == 7
        assert again.model == "fixture"

    asyncio.run(run())


def test_record_then_replay_text_roundtrip(tmp_path: Path) -> None:
    async def run() -> None:
        live = FakeLlm(texts=["hello"])
        rec = FixtureLlm(tmp_path, record=True, live=live)
        r = await rec.generate_text(GenerateTextRequest(prompt="p"))
        assert r.text == "hello"

        rep = FixtureLlm(tmp_path)
        again = await rep.generate_text(GenerateTextRequest(prompt="p"))
        assert again.text == "hello"

    asyncio.run(run())


def test_key_format_matches_ts(tmp_path: Path) -> None:
    async def run() -> None:
        live = FakeLlm(objects=[{"n": 1}])
        rec = FixtureLlm(tmp_path, record=True, live=live)
        await rec.generate_object(
            GenerateObjectRequest(schema=JsonSchema(json_schema={}), schema_name="s", prompt="p")
        )
        # key = the first 24 hex digits of sha256(["object", schemaName, system, prompt] joined with NUL).
        # system unspecified → empty string. The key formula is the same NUL join as _key_of.
        expected_key = sha256_hex("object\x00s\x00\x00p")[:24]
        assert (tmp_path / f"{expected_key}.json").exists()

    asyncio.run(run())


def test_record_mode_requires_live(tmp_path: Path) -> None:
    with pytest.raises(LlmError) as exc:
        FixtureLlm(tmp_path, record=True)
    assert exc.value.code == "CONFIG"


def test_missing_fixture_raises(tmp_path: Path) -> None:
    async def run() -> None:
        rep = FixtureLlm(tmp_path)
        with pytest.raises(LlmError) as exc:
            await rep.generate_object(GenerateObjectRequest(schema=_Shape, prompt="nope"))
        assert exc.value.code == "INVALID_OUTPUT"

    asyncio.run(run())


def test_corrupt_fixture_raises(tmp_path: Path) -> None:
    async def run() -> None:
        live = FakeLlm(objects=[{"n": 3}])
        rec = FixtureLlm(tmp_path, record=True, live=live)
        await rec.generate_object(
            GenerateObjectRequest(schema=_Shape, schema_name="s", prompt="p")
        )
        # Corrupt the recorded fixture.
        files = list(tmp_path.glob("*.json"))
        assert len(files) == 1
        files[0].write_text("{ this is not json", encoding="utf-8")

        rep = FixtureLlm(tmp_path)
        with pytest.raises(LlmError) as exc:
            await rep.generate_object(
                GenerateObjectRequest(schema=_Shape, schema_name="s", prompt="p")
            )
        assert exc.value.code == "INVALID_OUTPUT"

    asyncio.run(run())


def test_replay_schema_mismatch_raises(tmp_path: Path) -> None:
    async def run() -> None:
        # Record an invalid shape with a non-validating schema (JsonSchema) → replaying with a validating schema fails explicitly.
        # The key depends only on schemaName + system + prompt, not on the schema itself, so the same-key fixture can be replayed with a different schema.
        live = FakeLlm(objects=[{"wrong": 1}])
        rec = FixtureLlm(tmp_path, record=True, live=live)
        await rec.generate_object(
            GenerateObjectRequest(schema=JsonSchema(json_schema={}), schema_name="s", prompt="p")
        )
        rep = FixtureLlm(tmp_path)
        with pytest.raises(LlmError) as exc:
            await rep.generate_object(
                GenerateObjectRequest(schema=_Shape, schema_name="s", prompt="p")
            )
        assert exc.value.code == "INVALID_OUTPUT"

    asyncio.run(run())


def test_fixture_file_is_ts_compatible_json(tmp_path: Path) -> None:
    async def run() -> None:
        live = FakeLlm(objects=[{"n": 42}])
        rec = FixtureLlm(tmp_path, record=True, live=live)
        await rec.generate_object(
            GenerateObjectRequest(schema=_Shape, schema_name="s", prompt="long prompt")
        )
        files = list(tmp_path.glob("*.json"))
        data: dict[str, Any] = json.loads(files[0].read_text(encoding="utf-8"))
        # TS-compatible format: object (the response body) and prompt (the first 400 chars).
        assert data["object"] == {"n": 42}
        assert data["prompt"] == "long prompt"

    asyncio.run(run())
