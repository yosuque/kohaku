"""Tests for error_body's RATE_LIMITED / retryAfterMs wire shape (port of
packages/host-rest/test/rate-limited-error.test.ts). See that file's docstring for what this pins vs.
what the rate-limiter middleware tests exercise once wired.
"""

from __future__ import annotations

from kohaku.host_rest.errors import error_body


def test_error_body_rate_limited_carries_retry_after_ms_when_given() -> None:
    assert error_body("RATE_LIMITED", "rate limit exceeded", retry_after_ms=1500) == {
        "error": {"code": "RATE_LIMITED", "message": "rate limit exceeded", "retryAfterMs": 1500}
    }


def test_error_body_rate_limited_omits_retry_after_ms_when_not_given() -> None:
    assert error_body("RATE_LIMITED", "rate limit exceeded") == {
        "error": {"code": "RATE_LIMITED", "message": "rate limit exceeded"}
    }


def test_error_body_rate_limited_carries_both_request_id_and_retry_after_ms() -> None:
    assert error_body("RATE_LIMITED", "rate limit exceeded", "req-1", 2000) == {
        "error": {
            "code": "RATE_LIMITED",
            "message": "rate limit exceeded",
            "requestId": "req-1",
            "retryAfterMs": 2000,
        }
    }
