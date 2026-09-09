"""Tests for BindingClient (pytest version of data-binding/test/binding.test.ts).

Mocks fetcher / action_fetcher to check normal resolution, capability attachment, STALE reconciliation,
in-flight sharing, reserved parameters (page/sort), ActionResult parsing, and bind-variant reconciliation skip.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from kohaku.data_binding import (
    ActionOptions,
    BindingClientConfig,
    BindingError,
    FetchInit,
    FetchResponseLike,
    PageOptions,
    QueryRef,
    ResolveOptions,
    SortOptions,
    create_binding_client,
    parse_query_ref,
    resolve_bound_ref,
)
from kohaku.spec import DataRef

_DATA: dict[str, Any] = {
    "columns": [{"key": "region", "type": "string"}, {"key": "revenue", "type": "number"}],
    "rows": [{"region": "japan", "revenue": 100}, {"region": "apac", "revenue": 50}],
    "dataVersion": "sales@seed-1",
}


def _rows(data: Any) -> list[Any]:
    """Extract rows from resolve's return value (raw payload) (narrowing for mypy)."""
    rows = data["rows"]
    assert isinstance(rows, list)
    return rows


def _const_fetcher(status: int, body: Any) -> Any:
    async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
        return FetchResponseLike(status=status, body=body)

    return fetcher


def _const_action_fetcher(status: int, body: Any) -> Any:
    async def action_fetcher(_a: str, _p: Any, _init: FetchInit) -> FetchResponseLike:
        return FetchResponseLike(status=status, body=body)

    return action_fetcher


class TestResolve:
    def test_success_attaches_capability_and_canonical_ref(self) -> None:
        seen: dict[str, Any] = {}

        async def fetcher(ref: QueryRef, init: FetchInit) -> FetchResponseLike:
            seen["raw"] = ref.raw
            seen["capability"] = init.capability
            return FetchResponseLike(status=200, body=_DATA)

        client = create_binding_client(BindingClientConfig(capability="cap-token", fetcher=fetcher))
        data = asyncio.run(
            client.resolve(
                {"$ref": "query://sales/summary?q=3&fy=2026"},
                ResolveOptions(expected_data_version="sales@seed-1"),
            )
        )
        assert len(_rows(data)) == 2
        assert seen["raw"] == "query://sales/summary?fy=2026&q=3"
        assert seen["capability"] == "cap-token"

    def test_capability_function_is_evaluated_each_call(self) -> None:
        seen: list[str | None] = []

        async def fetcher(_ref: QueryRef, init: FetchInit) -> FetchResponseLike:
            seen.append(init.capability)
            return FetchResponseLike(status=200, body=_DATA)

        cap = "cap-a"
        client = create_binding_client(BindingClientConfig(capability=lambda: cap, fetcher=fetcher))
        asyncio.run(client.resolve("query://sales/summary"))
        cap = "cap-b"
        asyncio.run(client.resolve("query://sales/records"))
        assert seen == ["cap-a", "cap-b"]

    def test_401_403_unauthorized(self) -> None:
        client = create_binding_client(BindingClientConfig(fetcher=_const_fetcher(403, None)))
        with pytest.raises(BindingError) as ei:
            asyncio.run(client.resolve("query://sales/summary"))
        assert ei.value.code == "UNAUTHORIZED"

    def test_404_ref_not_found(self) -> None:
        client = create_binding_client(BindingClientConfig(fetcher=_const_fetcher(404, None)))
        with pytest.raises(BindingError) as ei:
            asyncio.run(client.resolve("query://sales/summary"))
        assert ei.value.code == "REF_NOT_FOUND"

    def test_stale_version_mismatch(self) -> None:
        client = create_binding_client(
            BindingClientConfig(fetcher=_const_fetcher(200, {**_DATA, "dataVersion": "sales@seed-2"}))
        )
        with pytest.raises(BindingError) as ei:
            asyncio.run(
                client.resolve(
                    "query://sales/summary", ResolveOptions(expected_data_version="sales@seed-1")
                )
            )
        assert ei.value.code == "STALE_VERSION"

    def test_bad_ref_does_not_fetch(self) -> None:
        called = False

        async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
            nonlocal called
            called = True
            return FetchResponseLike(status=200, body=_DATA)

        client = create_binding_client(BindingClientConfig(fetcher=fetcher))
        with pytest.raises(BindingError) as ei:
            asyncio.run(client.resolve("not-a-ref"))
        assert ei.value.code == "BAD_REF"
        assert called is False

    def test_malformed_payload(self) -> None:
        client = create_binding_client(BindingClientConfig(fetcher=_const_fetcher(200, {"rows": "x"})))
        with pytest.raises(BindingError) as ei:
            asyncio.run(client.resolve("query://sales/summary"))
        assert ei.value.code == "RESOLVE_FAILED"


class TestDataVersionOmission:
    def test_omitted_version_with_expected_is_stale(self) -> None:
        without_version = {k: v for k, v in _DATA.items() if k != "dataVersion"}
        client = create_binding_client(
            BindingClientConfig(fetcher=_const_fetcher(200, without_version))
        )
        with pytest.raises(BindingError) as ei:
            asyncio.run(
                client.resolve(
                    "query://sales/summary", ResolveOptions(expected_data_version="sales@seed-1")
                )
            )
        assert ei.value.code == "STALE_VERSION"

    def test_omitted_version_without_expected_resolves(self) -> None:
        without_version = {k: v for k, v in _DATA.items() if k != "dataVersion"}
        client = create_binding_client(
            BindingClientConfig(fetcher=_const_fetcher(200, without_version))
        )
        data = asyncio.run(client.resolve("query://sales/summary"))
        assert len(_rows(data)) == 2


class TestInflightDedup:
    def test_concurrent_same_ref_fetches_once(self) -> None:
        async def run() -> None:
            calls = 0
            gate = asyncio.Event()

            async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
                nonlocal calls
                calls += 1
                await gate.wait()
                return FetchResponseLike(status=200, body=_DATA)

            client = create_binding_client(BindingClientConfig(fetcher=fetcher))
            # Even with notation variance (key order), if the normalized ref is identical it is shared.
            p1 = asyncio.ensure_future(client.resolve("query://sales/summary?q=3&fy=2026"))
            p2 = asyncio.ensure_future(client.resolve({"$ref": "query://sales/summary?fy=2026&q=3"}))
            await asyncio.sleep(0)  # let the fetcher start
            gate.set()
            d1, d2 = await asyncio.gather(p1, p2)
            assert calls == 1
            assert len(_rows(d1)) == 2
            assert d2 == d1

        asyncio.run(run())

    def test_failure_propagates_and_clears_dedup(self) -> None:
        async def run() -> None:
            calls = 0
            gate = asyncio.Event()

            async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
                nonlocal calls
                calls += 1
                if calls == 1:
                    await gate.wait()
                    raise RuntimeError("boom")
                return FetchResponseLike(status=200, body=_DATA)

            client = create_binding_client(BindingClientConfig(fetcher=fetcher))
            p1 = asyncio.ensure_future(client.resolve("query://sales/summary"))
            p2 = asyncio.ensure_future(client.resolve("query://sales/summary"))
            await asyncio.sleep(0)
            gate.set()
            with pytest.raises(RuntimeError):
                await p1
            with pytest.raises(RuntimeError):
                await p2
            assert calls == 1
            # After settling, dedup is cleared → re-fetch.
            data = await client.resolve("query://sales/summary")
            assert len(_rows(data)) == 2
            assert calls == 2

        asyncio.run(run())

    def test_different_expected_version_not_shared(self) -> None:
        async def run() -> None:
            calls = 0

            async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
                nonlocal calls
                calls += 1
                return FetchResponseLike(status=200, body=_DATA)

            client = create_binding_client(BindingClientConfig(fetcher=fetcher))
            await asyncio.gather(
                client.resolve(
                    "query://sales/summary", ResolveOptions(expected_data_version="sales@seed-1")
                ),
                client.resolve("query://sales/summary"),
            )
            assert calls == 2

        asyncio.run(run())

    def test_different_capability_not_shared(self) -> None:
        """Simulates a tenant switch mid-flight: without an auth-context fingerprint in the dedup key,
        the second caller would collide with the first's in-flight promise and silently receive tenant
        A's data under tenant B's request."""

        async def run() -> None:
            cap = "cap-a"
            seen: list[str | None] = []
            gate = asyncio.Event()

            async def fetcher(_ref: QueryRef, init: FetchInit) -> FetchResponseLike:
                seen.append(init.capability)
                await gate.wait()  # keep the first resolve in flight while the second one arrives
                return FetchResponseLike(
                    status=200, body={**_DATA, "dataVersion": f"sales@{init.capability}"}
                )

            client = create_binding_client(BindingClientConfig(capability=lambda: cap, fetcher=fetcher))
            p1 = asyncio.ensure_future(client.resolve("query://sales/summary"))
            # A coroutine evaluates its capability getter only once scheduled, so let the first resolve
            # start (and register its in-flight entry under cap-a) before switching the tenant.
            await asyncio.sleep(0)
            cap = "cap-b"
            p2 = asyncio.ensure_future(client.resolve("query://sales/summary"))
            await asyncio.sleep(0)
            gate.set()
            d1, d2 = await asyncio.gather(p1, p2)
            assert seen == ["cap-a", "cap-b"]
            assert d1["dataVersion"] == "sales@cap-a"
            assert d2["dataVersion"] == "sales@cap-b"

        asyncio.run(run())

    def test_same_auth_context_still_shared(self) -> None:
        async def run() -> None:
            calls = 0
            gate = asyncio.Event()

            async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
                nonlocal calls
                calls += 1
                await gate.wait()
                return FetchResponseLike(status=200, body=_DATA)

            client = create_binding_client(
                BindingClientConfig(
                    capability=lambda: "cap-a",
                    headers=lambda: {"x-kohaku-tenant": "tenant-a"},
                    fetcher=fetcher,
                )
            )
            p1 = asyncio.ensure_future(client.resolve("query://sales/summary"))
            p2 = asyncio.ensure_future(client.resolve("query://sales/summary"))
            await asyncio.sleep(0)
            gate.set()
            await asyncio.gather(p1, p2)
            assert calls == 1

        asyncio.run(run())

    def test_signal_excluded_from_dedup(self) -> None:
        async def run() -> None:
            calls = 0
            gate = asyncio.Event()

            async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
                nonlocal calls
                calls += 1
                await gate.wait()
                return FetchResponseLike(status=200, body=_DATA)

            client = create_binding_client(BindingClientConfig(fetcher=fetcher))
            p1 = asyncio.ensure_future(client.resolve("query://sales/summary"))
            p2 = asyncio.ensure_future(
                client.resolve("query://sales/summary", ResolveOptions(signal=object()))
            )
            await asyncio.sleep(0)
            gate.set()
            await asyncio.gather(p1, p2)
            assert calls == 2

        asyncio.run(run())


class TestReservedParams:
    def test_page_sort_merged_and_recanonicalized(self) -> None:
        seen: dict[str, str] = {}

        async def fetcher(ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
            seen["raw"] = ref.raw
            return FetchResponseLike(status=200, body=_DATA)

        client = create_binding_client(BindingClientConfig(fetcher=fetcher))
        asyncio.run(
            client.resolve(
                "query://sales/records?fy=2026",
                ResolveOptions(
                    page=PageOptions(cursor="100:v1", limit=50),
                    sort=SortOptions(key="revenue", dir="desc"),
                ),
            )
        )
        assert seen["raw"] == (
            "query://sales/records?_cursor=100%3Av1&_dir=desc&_limit=50&_sort=revenue&fy=2026"
        )

    def test_no_page_sort_leaves_ref_unchanged(self) -> None:
        seen: dict[str, str] = {}

        async def fetcher(ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
            seen["raw"] = ref.raw
            return FetchResponseLike(status=200, body=_DATA)

        client = create_binding_client(BindingClientConfig(fetcher=fetcher))
        asyncio.run(client.resolve("query://sales/records?fy=2026"))
        assert seen["raw"] == "query://sales/records?fy=2026"

    def test_reserved_param_in_ref_is_bad_ref(self) -> None:
        called = False

        async def fetcher(_ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
            nonlocal called
            called = True
            return FetchResponseLike(status=200, body=_DATA)

        client = create_binding_client(BindingClientConfig(fetcher=fetcher))
        with pytest.raises(BindingError) as ei:
            asyncio.run(client.resolve("query://sales/records?_limit=50&fy=2026"))
        assert ei.value.code == "BAD_REF"
        assert called is False


class TestInvokeAction:
    def test_signal_propagates_to_action_fetcher(self) -> None:
        seen: dict[str, Any] = {}

        async def action_fetcher(_a: str, _p: Any, init: FetchInit) -> FetchResponseLike:
            seen["signal"] = init.signal
            return FetchResponseLike(status=200, body={"result": {"ok": True}})

        client = create_binding_client(
            BindingClientConfig(fetcher=_const_fetcher(200, _DATA), action_fetcher=action_fetcher)
        )
        signal = object()
        asyncio.run(client.invoke_action("annotate", {"note": "x"}, ActionOptions(signal=signal)))
        assert seen["signal"] is signal

    def test_action_result_result_only(self) -> None:
        client = create_binding_client(
            BindingClientConfig(
                fetcher=_const_fetcher(200, _DATA),
                action_fetcher=_const_action_fetcher(200, {"result": {"ok": True}}),
            )
        )
        res = asyncio.run(client.invoke_action("annotate", {}))
        assert res.result == {"ok": True}
        assert res.invalidates is None
        assert res.refVersions is None

    def test_action_result_with_effects(self) -> None:
        body = {
            "result": {"ok": True},
            "invalidates": ["query://sales/summary?fy=2026"],
            "refVersions": {"query://sales/summary?fy=2026": "v2"},
        }
        client = create_binding_client(
            BindingClientConfig(
                fetcher=_const_fetcher(200, _DATA), action_fetcher=_const_action_fetcher(200, body)
            )
        )
        res = asyncio.run(client.invoke_action("annotate", {}))
        assert res.invalidates == ["query://sales/summary?fy=2026"]
        assert res.refVersions == {"query://sales/summary?fy=2026": "v2"}

    def test_action_result_legacy_body_wrapped_as_result(self) -> None:
        # A body without a result key (a host that has not wired up action_effects) wraps the whole body as result.
        client = create_binding_client(
            BindingClientConfig(
                fetcher=_const_fetcher(200, _DATA),
                action_fetcher=_const_action_fetcher(200, {"ok": True, "note": "x"}),
            )
        )
        res = asyncio.run(client.invoke_action("annotate", {}))
        assert res.result == {"ok": True, "note": "x"}

    def test_action_denied(self) -> None:
        client = create_binding_client(
            BindingClientConfig(
                fetcher=_const_fetcher(200, _DATA), action_fetcher=_const_action_fetcher(403, None)
            )
        )
        with pytest.raises(BindingError) as ei:
            asyncio.run(client.invoke_action("annotate", {}))
        assert ei.value.code == "UNAUTHORIZED"

    def test_action_without_fetcher_raises(self) -> None:
        client = create_binding_client(BindingClientConfig(fetcher=_const_fetcher(200, _DATA)))
        with pytest.raises(BindingError) as ei:
            asyncio.run(client.invoke_action("annotate", {}))
        assert ei.value.code == "RESOLVE_FAILED"


class TestBindVariantVersionSkip:
    """Client-derived bind variants skip reconciliation (working with resolve_bound_ref).

    The initial variant ($ref) is reconciled with the spec's dataVersion, but a bind variant changed via
    $state is unrelated to the spec's version, so the caller resolves without passing expected_data_version
    (reconciliation skipped).
    """

    def test_variant_resolves_without_version_match(self) -> None:
        data_ref = DataRef.model_validate(
            {
                "$ref": "query://sales/summary?fy=2026&region=japan",
                "bind": {"region": {"$state": "region", "values": ["japan", "apac"]}},
            }
        )
        # Change $state from its initial value → the effective ref differs from $ref (= a client-derived bind variant).
        effective = resolve_bound_ref(data_ref, {"region": "apac"})
        assert effective != data_ref.ref

        seen: dict[str, str] = {}

        async def fetcher(ref: QueryRef, _init: FetchInit) -> FetchResponseLike:
            seen["raw"] = ref.raw
            # A version different from the spec's dataVersion. If reconciliation is skipped, it does not become STALE.
            return FetchResponseLike(
                status=200,
                body={
                    "columns": [{"key": "region", "type": "string"}],
                    "rows": [{"region": "apac"}],
                    "dataVersion": "variant-version",
                },
            )

        client = create_binding_client(BindingClientConfig(fetcher=fetcher))
        # The bind variant is passed without expected_data_version (reconciliation skipped) → resolves even with a different version.
        data = asyncio.run(client.resolve(effective))
        assert _rows(data)[0]["region"] == "apac"
        assert seen["raw"] == parse_query_ref(effective).raw

    def test_initial_variant_still_matches_version(self) -> None:
        # For contrast: the initial variant ($ref) is passed expected and reconciled (a mismatch is STALE).
        client = create_binding_client(
            BindingClientConfig(
                fetcher=_const_fetcher(
                    200,
                    {
                        "columns": [{"key": "region", "type": "string"}],
                        "rows": [{"region": "japan"}],
                        "dataVersion": "actual-version",
                    },
                )
            )
        )
        with pytest.raises(BindingError) as ei:
            asyncio.run(
                client.resolve(
                    "query://sales/summary?fy=2026&region=japan",
                    ResolveOptions(expected_data_version="spec-version"),
                )
            )
        assert ei.value.code == "STALE_VERSION"
