"""Black-box e2e for BindingClient (against host_rest's in-process FastAPI).

Using the capability from compose and the spec's dataVersion, confirms end to end that BindingClient.resolve
resolves from the real host's /binding/resolve and passes version reconciliation. The fetcher delegates to
host_rest's in-process TestClient (reusing the existing host_rest test style).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from kohaku.data_binding import (
    BindingClientConfig,
    FetchInit,
    FetchResponseLike,
    QueryRef,
    ResolveOptions,
    create_binding_client,
)

# Reuse the host_rest tests' common harness (build_harness). kohaku's test package name is "tests".
from tests.host_rest.conftest import INTENT_BODY, PREFIX, REF, build_harness


def _testclient_fetcher(test_client: Any) -> Any:
    """BindingFetcher that delegates to host_rest's in-process TestClient."""

    async def fetcher(ref: QueryRef, init: FetchInit) -> FetchResponseLike:
        headers = {"authorization": f"Bearer {init.capability}"} if init.capability else {}
        res = test_client.get(f"{PREFIX}/binding/resolve", params={"ref": ref.raw}, headers=headers)
        try:
            body: Any = res.json()
        except ValueError:
            body = None
        return FetchResponseLike(status=res.status_code, body=body)

    return fetcher


def test_compose_then_resolve_matches_version(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    body = harness.client.post(f"{PREFIX}/compose", json={"intent": INTENT_BODY}).json()
    capability = body["capability"]
    spec = body["spec"]
    # The caller's reconciliation target: refVersions?[ref] ?? dataVersion (the same derivation as the host_rest tests).
    expected = (spec.get("refVersions") or {}).get(REF, spec["dataVersion"])

    client = create_binding_client(
        BindingClientConfig(capability=capability, fetcher=_testclient_fetcher(harness.client))
    )
    data = asyncio.run(client.resolve(REF, ResolveOptions(expected_data_version=expected)))

    rows = data["rows"]
    assert data["dataVersion"] == expected
    assert isinstance(rows, list) and len(rows) >= 1


def test_resolve_without_capability_is_unauthorized(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    # Pass no capability → the host returns 401/403, and the client translates it to UNAUTHORIZED.
    client = create_binding_client(BindingClientConfig(fetcher=_testclient_fetcher(harness.client)))
    from kohaku.data_binding import BindingError

    try:
        asyncio.run(client.resolve(REF))
    except BindingError as e:
        assert e.code == "UNAUTHORIZED"
    else:
        raise AssertionError("UNAUTHORIZED should be raised")
