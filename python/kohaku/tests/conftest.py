"""Common path resolution for tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
"""The monorepo root (python/kohaku/tests → 3 levels up)."""

SPEC_DIR = REPO_ROOT / "spec"


@pytest.fixture(scope="session")
def example_spec_data() -> dict[str, Any]:
    data = json.loads(
        (SPEC_DIR / "examples/quarterly-sales.spec.json").read_text(encoding="utf-8")
    )
    assert isinstance(data, dict)
    return data


@pytest.fixture(scope="session")
def cross_language_fixture() -> dict[str, Any]:
    data = json.loads(
        (SPEC_DIR / "test/fixtures/cross-language-canonical.json").read_text(encoding="utf-8")
    )
    assert isinstance(data, dict)
    return data
