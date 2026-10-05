"""When the LLM provider cannot serve an Intent-resolution call (no API key, provider failure, abort), the REST
host must answer 503 INTERNAL with a fixed message instead of 422 INTENT_INVALID carrying the provider SDK's raw
wording. Covers every route that resolves an Intent: /intent/normalize, /events, /compose, /compose/stream and
/fixations/approve; the original error must still reach on_error. A typed error and an
IntentValidationError keep 422 with their own message, and a directly-specified Intent on /compose still
degrades to a fallback Spec (200). Port of packages/host-rest/test/llm-unavailable.test.ts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from kohaku.composer import ComposeContext
from kohaku.host_core import LLM_PROVIDER_UNAVAILABLE_MESSAGE
from kohaku.host_rest import HostErrorInfo, KohakuHostDeps, attach_kohaku_routes
from kohaku.host_rest._routes.compose import _INTENT_INVALID_MESSAGE
from kohaku.lineage import create_fixations, create_lineage, create_view_recorder
from kohaku.llm import FakeLlm, LlmError
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    DataShape,
    Intent,
    IntentInput,
    IntentValidationError,
    QueryHandle,
    SemanticInput,
    SessionContext,
)
from kohaku.storage import FileStoragePort

from .conftest import PREFIX, REF, FakeAuthz, FakeDomain, FakeSemantic

_RAW_SDK_MESSAGE = (
    "[claude/claude-sonnet-5] Anthropic API key is missing. Pass it using the 'apiKey' parameter "
    "or the ANTHROPIC_API_KEY environment variable."
)


class FailingSemantic:
    """A SemanticPort whose normalize and validate_intent both raise `error`."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        raise self._error

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return QueryHandle(uri=REF)

    async def data_version(self, handle: QueryHandle) -> str:
        return "sales@v1"

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        return None

    async def validate_intent(self, intent: IntentInput, ctx: SessionContext) -> IntentInput:
        raise self._error


def _provider_failure(_req: Any) -> Any:
    raise LlmError("PROVIDER", _RAW_SDK_MESSAGE)


def _build(
    tmp_path: Path, semantic: Any, llm: FakeLlm | None = None
) -> tuple[TestClient, list[HostErrorInfo]]:
    seen: list[HostErrorInfo] = []
    storage = FileStoragePort(tmp_path)
    catalog = resolve_catalog(core_catalog())
    ctx = ComposeContext(
        catalog=catalog,
        semantic=semantic,
        storage=storage,
        llm=llm if llm is not None else FakeLlm(),
    )
    lineage = create_lineage(storage)
    deps = KohakuHostDeps(
        compose=ctx,
        domain=FakeDomain(),
        authz=FakeAuthz(),
        query_source="sales",
        recorder=create_view_recorder(lineage),
        fixations=create_fixations(
            lineage=lineage, storage=storage, catalog_for=lambda _t: catalog
        ),
        on_error=lambda info: seen.append(info),
    )
    app = FastAPI()
    attach_kohaku_routes(app, deps)
    return TestClient(app), seen


_CASES: list[tuple[str, str, dict[str, Any]]] = [
    ("/intent/normalize", "/intent/normalize", {"input": {"kind": "nl", "text": "revenue"}}),
    (
        "/events",
        "/events",
        {
            "intent": {"canonical": "sales.trend", "params": {}},
            "event": {"on": "table1.sort", "payload": {}},
        },
    ),
    ("/compose (nl)", "/compose", {"input": {"kind": "nl", "text": "revenue"}}),
    ("/compose/stream (nl)", "/compose/stream", {"input": {"kind": "nl", "text": "revenue"}}),
    (
        "/fixations/approve",
        "/fixations/approve",
        {"intent": {"canonical": "sales.trend", "params": {}}},
    ),
]


@pytest.mark.parametrize("code", ["PROVIDER", "CONFIG", "ABORTED"])
@pytest.mark.parametrize(("name", "path", "body"), _CASES, ids=[c[0] for c in _CASES])
def test_an_unavailable_llm_provider_is_503_internal_with_the_fixed_message(
    tmp_path: Path, code: str, name: str, path: str, body: dict[str, Any]
) -> None:
    error = LlmError(code, _RAW_SDK_MESSAGE)  # type: ignore[arg-type]
    client, seen = _build(tmp_path, FailingSemantic(error))

    res = client.post(f"{PREFIX}{path}", json=body)

    assert res.status_code == 503, name
    assert "API key" not in res.text
    assert "ANTHROPIC_API_KEY" not in res.text
    envelope: dict[str, Any] = res.json()
    assert envelope["error"]["code"] == "INTERNAL"
    assert envelope["error"]["message"] == LLM_PROVIDER_UNAVAILABLE_MESSAGE
    request_id = envelope["error"]["requestId"]
    assert isinstance(request_id, str)
    assert request_id != ""
    # The detail stays operator-side: on_error receives the original LlmError with the same request id.
    assert [(info.error, info.request_id) for info in seen] == [(error, request_id)]


def test_llm_error_invalid_output_collapses_to_the_fixed_intent_invalid_message(
    tmp_path: Path,
) -> None:
    client, _seen = _build(tmp_path, FailingSemantic(LlmError("INVALID_OUTPUT", _RAW_SDK_MESSAGE)))

    res = client.post(
        f"{PREFIX}/intent/normalize", json={"input": {"kind": "nl", "text": "revenue"}}
    )

    assert res.status_code == 422
    assert "API key" not in res.text
    envelope: dict[str, Any] = res.json()
    assert envelope["error"]["code"] == "INTENT_INVALID"
    assert envelope["error"]["message"] == _INTENT_INVALID_MESSAGE


def test_an_intent_validation_error_is_422_with_its_own_message(tmp_path: Path) -> None:
    client, _seen = _build(
        tmp_path, FailingSemantic(IntentValidationError('unknown intent "sales.bogus"'))
    )

    res = client.post(
        f"{PREFIX}/fixations/approve", json={"intent": {"canonical": "sales.bogus", "params": {}}}
    )

    assert res.status_code == 422
    envelope: dict[str, Any] = res.json()
    assert envelope["error"]["code"] == "INTENT_INVALID"
    assert 'unknown intent "sales.bogus"' in envelope["error"]["message"]


def test_a_typed_no_match_error_is_422_with_its_own_message(tmp_path: Path) -> None:
    no_match = Exception("no intent matches the question")
    no_match.code = "NO_MATCH"  # type: ignore[attr-defined]
    client, _seen = _build(tmp_path, FailingSemantic(no_match))

    res = client.post(
        f"{PREFIX}/intent/normalize", json={"input": {"kind": "nl", "text": "revenue"}}
    )

    assert res.status_code == 422
    envelope: dict[str, Any] = res.json()
    assert envelope["error"]["code"] == "INTENT_INVALID"
    assert envelope["error"]["message"] == "no intent matches the question"


def test_a_directly_specified_intent_still_degrades_to_a_fallback_spec(tmp_path: Path) -> None:
    """The L1 generation failing with an LlmError PROVIDER is 200 + provenance.fallback, not 503."""
    client, _seen = _build(tmp_path, FakeSemantic(), FakeLlm(objects=_provider_failure))

    res = client.post(
        f"{PREFIX}/compose", json={"intent": {"canonical": "sales.summary", "params": {"fy": 2026}}}
    )

    assert res.status_code == 200
    assert res.json()["spec"]["provenance"].get("fallback") is not None
