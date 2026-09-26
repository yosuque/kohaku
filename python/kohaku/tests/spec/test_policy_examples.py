"""Accept/reject parity for spec/examples/policy/{valid,invalid} (port of
packages/spec-core/test/policy.test.ts / spec/test/policy-examples.test.ts).

Both languages must accept exactly the "valid" set and reject exactly the "invalid" set from the same
files, so a schema drift between the Zod (packages/spec-core/src/schema/policy.ts) and Pydantic
(kohaku.spec.policy) ports is caught here rather than only in each language's own hand-written tests.
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from kohaku.spec.policy import KohakuPolicyFile

from ..conftest import REPO_ROOT

EXAMPLES_DIR = REPO_ROOT / "spec" / "examples" / "policy"


def _example_names(kind: str) -> list[str]:
    return sorted(p.name for p in (EXAMPLES_DIR / kind).glob("*.json"))


def _read_example(kind: str, name: str) -> dict[str, object]:
    data = json.loads((EXAMPLES_DIR / kind / name).read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


def test_each_directory_has_at_least_one_example() -> None:
    # A directory typo (or an empty fixture set) would otherwise make the parametrized tests below
    # pass vacuously.
    assert _example_names("valid")
    assert _example_names("invalid")


@pytest.mark.parametrize("name", _example_names("valid"))
def test_accepts_valid_example(name: str) -> None:
    KohakuPolicyFile.model_validate(_read_example("valid", name))


@pytest.mark.parametrize("name", _example_names("invalid"))
def test_rejects_invalid_example(name: str) -> None:
    with pytest.raises(ValidationError):
        KohakuPolicyFile.model_validate(_read_example("invalid", name))
