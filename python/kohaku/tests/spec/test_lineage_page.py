"""Tests for kohaku.spec.lineage_page (port of packages/spec-core/test/lineage-page.test.ts): the opaque
seq cursor codec and page_lineage_events, the array-backed pageLineage reference implementation.
"""

from __future__ import annotations

import base64
import json

import pytest

from kohaku.spec import (
    DEFAULT_LINEAGE_PAGE_SIZE,
    MAX_LINEAGE_PAGE_SIZE,
    LineageActor,
    LineageCursorError,
    LineageEventRecord,
    LineagePageRequest,
    clamp_lineage_page_size,
    decode_seq_cursor,
    encode_seq_cursor,
    page_lineage_events,
)


def _event(event_id: str, ts: str, **payload: object) -> LineageEventRecord:
    return LineageEventRecord(
        id=event_id, ts=ts, actor=LineageActor(kind="system"), type="view.composed", payload=payload
    )


def _to_base64url_json(value: object) -> str:
    """Builds a base64url string from an arbitrary JSON value, bypassing encode_seq_cursor's {v,seq}
    shape -- used only to construct malformed-but-valid-base64url cursors below."""
    raw = json.dumps(value).encode("ascii")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


class TestSeqCursorCodec:
    def test_round_trips_a_seq_value(self) -> None:
        assert decode_seq_cursor(encode_seq_cursor(0)) == 0
        assert decode_seq_cursor(encode_seq_cursor(1)) == 1
        assert decode_seq_cursor(encode_seq_cursor(123456789)) == 123456789

    def test_produces_a_base64url_string(self) -> None:
        cursor = encode_seq_cursor(999999)
        assert "+" not in cursor
        assert "/" not in cursor
        assert "=" not in cursor

    def test_decodes_a_ts_produced_cursor(self) -> None:
        """A cursor built by hand in the same {"v":1,"seq":n} shape TS's encoder produces must decode
        identically -- the cross-language compatibility this codec exists for."""
        cursor = _to_base64url_json({"v": 1, "seq": 42})
        assert decode_seq_cursor(cursor) == 42

    def test_raises_for_a_malformed_cursor(self) -> None:
        with pytest.raises(LineageCursorError):
            decode_seq_cursor("not-base64url-json")
        with pytest.raises(LineageCursorError):
            decode_seq_cursor("")
        with pytest.raises(LineageCursorError):
            decode_seq_cursor(_to_base64url_json({"foo": "bar"}))
        with pytest.raises(LineageCursorError):
            decode_seq_cursor(_to_base64url_json({"v": 2, "seq": 1}))
        with pytest.raises(LineageCursorError):
            decode_seq_cursor(_to_base64url_json({"v": 1, "seq": "1"}))
        with pytest.raises(LineageCursorError):
            decode_seq_cursor(_to_base64url_json({"v": 1, "seq": 1.5}))

    def test_rejects_a_negative_or_unsafe_seq(self) -> None:
        # A negative seq would rewind the scan; anything past 2**53 - 1 cannot round-trip through TS.
        for seq in (-1, -0.5, 2**53, 10**400):
            with pytest.raises(LineageCursorError):
                decode_seq_cursor(_to_base64url_json({"v": 1, "seq": seq}))
        assert decode_seq_cursor(_to_base64url_json({"v": 1, "seq": 2**53 - 1})) == 2**53 - 1


class TestPageLineageEvents:
    def _events(self) -> list[LineageEventRecord]:
        return [_event(f"e{i}", f"2026-01-0{i + 1}T00:00:00.000Z", intentHash=f"h{i + 1}") for i in range(5)]

    def test_returns_everything_in_one_page_with_no_next_cursor(self) -> None:
        events = self._events()
        page = page_lineage_events(events, LineagePageRequest())
        assert [e.id for e in page.events] == [e.id for e in events]
        assert page.nextCursor is None

    def test_defaults_and_clamps_page_size(self) -> None:
        assert DEFAULT_LINEAGE_PAGE_SIZE == 500
        assert MAX_LINEAGE_PAGE_SIZE == 1000
        page = page_lineage_events(self._events(), LineagePageRequest(pageSize=1_000_000))
        assert len(page.events) == 5
        assert page.nextCursor is None

    def test_clamp_lineage_page_size_defaults_floors_and_clamps(self) -> None:
        assert clamp_lineage_page_size() == DEFAULT_LINEAGE_PAGE_SIZE
        assert clamp_lineage_page_size(float("nan")) == DEFAULT_LINEAGE_PAGE_SIZE
        assert clamp_lineage_page_size(2.5) == 2
        assert clamp_lineage_page_size(0.5) == 1
        assert clamp_lineage_page_size(0) == 1
        assert clamp_lineage_page_size(-7) == 1
        assert clamp_lineage_page_size(1_000_000) == MAX_LINEAGE_PAGE_SIZE
        assert clamp_lineage_page_size(float("inf")) == MAX_LINEAGE_PAGE_SIZE
        assert clamp_lineage_page_size(float("-inf")) == 1

    def test_fractional_page_size_is_floored(self) -> None:
        page = page_lineage_events(self._events(), LineagePageRequest(pageSize=2.5))  # type: ignore[arg-type]
        assert len(page.events) == 2
        assert page.nextCursor is not None

    def test_pages_forward_in_ascending_order_with_no_gaps_or_duplicates(self) -> None:
        events = self._events()
        page1 = page_lineage_events(events, LineagePageRequest(pageSize=2))
        assert [e.id for e in page1.events] == [events[0].id, events[1].id]
        assert page1.nextCursor is not None

        page2 = page_lineage_events(events, LineagePageRequest(pageSize=2, cursor=page1.nextCursor))
        assert [e.id for e in page2.events] == [events[2].id, events[3].id]
        assert page2.nextCursor is not None

        page3 = page_lineage_events(events, LineagePageRequest(pageSize=2, cursor=page2.nextCursor))
        assert [e.id for e in page3.events] == [events[4].id]
        assert page3.nextCursor is None

    def test_append_between_pages_is_visible_without_disturbing_earlier_pages(self) -> None:
        events = self._events()
        page1 = page_lineage_events(events, LineagePageRequest(pageSize=3))
        assert len(page1.events) == 3
        events = [*events, _event("e5", "2026-01-06T00:00:00.000Z")]
        page2 = page_lineage_events(events, LineagePageRequest(pageSize=3, cursor=page1.nextCursor))
        assert [e.id for e in page2.events] == [events[3].id, events[4].id, events[5].id]
        assert page2.nextCursor is None

    def test_combines_with_a_correlation_id_filter(self) -> None:
        mixed = [
            _event("e0", "2026-01-01T00:00:00.000Z", correlationId="c1"),
            _event("e1", "2026-01-02T00:00:00.000Z", correlationId="other"),
            _event("e2", "2026-01-03T00:00:00.000Z", correlationId="c1"),
            _event("e3", "2026-01-04T00:00:00.000Z", correlationId="other"),
            _event("e4", "2026-01-05T00:00:00.000Z", correlationId="c1"),
        ]
        page1 = page_lineage_events(mixed, LineagePageRequest(correlationId="c1", pageSize=2))
        assert [e.id for e in page1.events] == ["e0", "e2"]
        assert page1.nextCursor is not None
        page2 = page_lineage_events(
            mixed, LineagePageRequest(correlationId="c1", pageSize=2, cursor=page1.nextCursor)
        )
        assert [e.id for e in page2.events] == ["e4"]
        assert page2.nextCursor is None

    def test_combines_with_a_tenant_filter(self) -> None:
        mixed = [
            LineageEventRecord(
                id="e0",
                ts="2026-01-01T00:00:00.000Z",
                actor=LineageActor(kind="system"),
                type="view.composed",
                payload={},
                tenant="t1",
            ),
            LineageEventRecord(
                id="e1",
                ts="2026-01-02T00:00:00.000Z",
                actor=LineageActor(kind="system"),
                type="view.composed",
                payload={},
                tenant="t2",
            ),
        ]
        page = page_lineage_events(mixed, LineagePageRequest(tenant="t1"))
        assert [e.id for e in page.events] == ["e0"]

    def test_clamps_a_page_size_of_zero_or_less_up_to_one(self) -> None:
        events = self._events()
        page1 = page_lineage_events(events, LineagePageRequest(pageSize=0))
        assert len(page1.events) == 1
        assert page1.events[0].id == events[0].id
        assert page1.nextCursor is not None
        assert page1.nextCursor != encode_seq_cursor(0)

    def test_raises_for_a_malformed_cursor(self) -> None:
        with pytest.raises(LineageCursorError):
            page_lineage_events(self._events(), LineagePageRequest(cursor="garbage"))
