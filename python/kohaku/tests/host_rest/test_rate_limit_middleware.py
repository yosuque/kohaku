"""Tests for the rate-limit wiring (check_rate_limit, port of rate-limit-middleware.test.ts).

Uses build_harness's `rate_limiter` override (a stub PolicyRateLimiter) rather than a real
RateLimitStore/policy file -- this module tests only the REST-layer wiring (which routes call
check_rate_limit, with which route_class, and how a denial is turned into a 429 response), not the
PolicyRuntime's own rate-limit resolution logic (already covered by test_policy.py).
"""

from __future__ import annotations

from pathlib import Path

from starlette.requests import Request

from kohaku.host_core import PolicyRateLimiter, PolicyRateLimiterTakeParams
from kohaku.spec import Principal, RateLimitResult

from .conftest import PREFIX, Harness, build_harness


def _url(path: str) -> str:
    return f"{PREFIX}{path}"


class _StubRateLimiter(PolicyRateLimiter):
    """A rate limiter stub whose take() always returns `result` and records every call."""

    def __init__(self, result: RateLimitResult) -> None:
        self.result = result
        self.calls: list[PolicyRateLimiterTakeParams] = []

    async def take(self, params: PolicyRateLimiterTakeParams) -> RateLimitResult:
        self.calls.append(params)
        return self.result


def _harness_with(tmp_path: Path, result: RateLimitResult) -> tuple[Harness, _StubRateLimiter]:
    limiter = _StubRateLimiter(result)
    harness = build_harness(tmp_path, rate_limiter=limiter)
    return harness, limiter


def test_does_not_affect_compose_when_rate_limiter_is_unset(tmp_path: Path) -> None:
    harness = build_harness(tmp_path)
    res = harness.client.post(_url("/compose"), json={"intent": harness.intent_body})
    assert res.status_code == 200


def test_returns_429_rate_limited_with_retry_after_for_compose(tmp_path: Path) -> None:
    harness, _limiter = _harness_with(tmp_path, RateLimitResult(allow=False, retryAfterMs=2500))
    res = harness.client.post(_url("/compose"), json={"intent": harness.intent_body})
    assert res.status_code == 429
    assert res.headers.get("Retry-After") == "3"  # ceil(2500 / 1000)
    assert res.json() == {
        "error": {"code": "RATE_LIMITED", "message": "rate limit exceeded", "retryAfterMs": 2500}
    }


def test_returns_429_without_retry_after_header_when_not_given(tmp_path: Path) -> None:
    harness, _limiter = _harness_with(tmp_path, RateLimitResult(allow=False))
    res = harness.client.post(_url("/compose"), json={"intent": harness.intent_body})
    assert res.status_code == 429
    assert "Retry-After" not in res.headers


def test_denies_binding_action_with_route_class_action(tmp_path: Path) -> None:
    harness, limiter = _harness_with(tmp_path, RateLimitResult(allow=False, retryAfterMs=1000))
    res = harness.client.post(_url("/binding/action"), json={"action": "annotate", "payload": {}})
    assert res.status_code == 429
    assert limiter.calls[0].routeClass == "action"


def test_denies_binding_resolve_with_route_class_resolve(tmp_path: Path) -> None:
    harness, limiter = _harness_with(tmp_path, RateLimitResult(allow=False, retryAfterMs=1000))
    res = harness.client.get(_url("/binding/resolve"), params={"ref": harness.ref})
    assert res.status_code == 429
    assert limiter.calls[0].routeClass == "resolve"


def test_does_not_apply_to_governance_routes_even_when_the_limiter_always_denies(tmp_path: Path) -> None:
    harness, _limiter = _harness_with(tmp_path, RateLimitResult(allow=False, retryAfterMs=1000))
    res = harness.client.get(_url("/lineage"))
    assert res.status_code != 429


def test_lets_the_request_through_and_the_handler_still_runs(tmp_path: Path) -> None:
    harness, _limiter = _harness_with(tmp_path, RateLimitResult(allow=True))
    res = harness.client.post(_url("/compose"), json={"intent": harness.intent_body})
    assert res.status_code == 200
    assert "spec" in res.json()


def test_passes_tenant_and_principal_id_through_to_rate_limiter_take(tmp_path: Path) -> None:
    def tenant(_request: Request) -> str:
        return "tenant-a"

    def auth(_request: Request) -> Principal:
        return Principal(id="alice", roles=["user"])

    limiter = _StubRateLimiter(RateLimitResult(allow=True))
    harness = build_harness(tmp_path, rate_limiter=limiter, tenant=tenant, auth=auth)
    harness.client.post(_url("/compose"), json={"intent": harness.intent_body})
    assert limiter.calls[0].tenant == "tenant-a"
    assert limiter.calls[0].principal == "alice"
    assert limiter.calls[0].routeClass == "compose"
