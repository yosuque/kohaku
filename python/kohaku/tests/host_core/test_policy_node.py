"""Tests for kohaku.host_core.policy_node (port of packages/host-core/test/policy-node.test.ts)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from kohaku.host_core import load_policy_file


def test_reads_parses_and_validates_a_policy_file_from_disk(tmp_path: Path) -> None:
    async def run() -> None:
        path = tmp_path / "kohaku.policy.json"
        path.write_text(json.dumps({"version": 1, "defaults": {"compose": {"allowL2": True}}}), encoding="utf-8")
        parsed = await load_policy_file(path)
        assert parsed.file.defaults.compose is not None
        assert parsed.file.defaults.compose.allowL2 is True
        assert parsed.policy_id.startswith("sha256:")

    asyncio.run(run())


def test_accepts_a_str_path_too(tmp_path: Path) -> None:
    async def run() -> None:
        path = tmp_path / "kohaku.policy.json"
        path.write_text(json.dumps({"version": 1, "defaults": {}}), encoding="utf-8")
        parsed = await load_policy_file(str(path))
        assert parsed.file.version == 1

    asyncio.run(run())


def test_rejects_a_file_that_fails_schema_validation(tmp_path: Path) -> None:
    async def run() -> None:
        path = tmp_path / "bad.policy.json"
        path.write_text(json.dumps({"version": 1, "defaults": {}, "bogus": True}), encoding="utf-8")
        with pytest.raises(ValidationError):
            await load_policy_file(path)

    asyncio.run(run())


def test_rejects_non_json_content(tmp_path: Path) -> None:
    async def run() -> None:
        path = tmp_path / "not-json.policy.json"
        path.write_text("not json at all", encoding="utf-8")
        with pytest.raises(json.JSONDecodeError):
            await load_policy_file(path)

    asyncio.run(run())


def test_rejects_a_missing_file(tmp_path: Path) -> None:
    async def run() -> None:
        with pytest.raises(FileNotFoundError):
            await load_policy_file(tmp_path / "missing.json")

    asyncio.run(run())
