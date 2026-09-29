"""parse_iso8601 mirrors packages/spec-core/src/iso8601.ts: impossible calendar dates and clock times are
rejected rather than rolled over (the REST /lineage and /analytics/summary routes answer them with 400)."""

import pytest

from kohaku.host_rest._routes.shared import parse_iso8601


def test_canonicalizes_to_utc() -> None:
    assert parse_iso8601("2026-09-30") == "2026-09-30T00:00:00.000Z"
    assert parse_iso8601("2026-09-30T09:00:00+09:00") == "2026-09-30T00:00:00.000Z"
    assert parse_iso8601("2028-02-29") == "2028-02-29T00:00:00.000Z"


@pytest.mark.parametrize(
    "raw",
    [
        "2026-02-30",
        "2026-02-29",
        "2026-04-31",
        "2026-00-10",
        "2026-09-00",
        "2026-02-30T00:00:00Z",
        "2026-09-30T24:00:00Z",
        "2026-09-30T00:60:00Z",
        "2026-09-30T00:00:00+24:00",
        "2026-09-30T00:00:00",
        "July 9, 2026",
    ],
)
def test_rejects_invalid_and_impossible_values(raw: str) -> None:
    assert parse_iso8601(raw) is None
