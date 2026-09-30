"""Forward (append-order) paging over the lineage log (design.md #53): the opaque `seq` cursor codec shared
by every StoragePort's optional `page_lineage` (port of packages/spec-core/src/lineage-page.ts), plus
`page_lineage_events`, a ready-made implementation for an adapter that keeps its lineage log as a plain
append-ordered list (kohaku.storage.file.FileStoragePort).

The wire format (`{"v":1,"seq":<seq>}`, base64url, unpadded) is shared byte-for-byte with the TS
implementation: a cursor produced by one language's host is a valid `cursor` to the other's.
"""

from __future__ import annotations

import base64
import json
import math
from typing import Any

from .ports import LineageEventRecord, LineagePage, LineagePageRequest

DEFAULT_LINEAGE_PAGE_SIZE = 500
"""LineagePageRequest.pageSize's default when omitted."""

MAX_LINEAGE_PAGE_SIZE = 1000
"""The upper bound pageSize is clamped to (an oversized request is truncated, not rejected)."""

_MAX_SAFE_INTEGER = 2**53 - 1
"""JavaScript's Number.MAX_SAFE_INTEGER: the largest seq the TS decoder accepts, mirrored here so both
languages reject the same cursors."""


def clamp_lineage_page_size(page_size: float | None = None) -> int:
    """The effective page size for a `LineagePageRequest.pageSize` (port of TS lineage-page.ts's
    clampLineagePageSize): DEFAULT_LINEAGE_PAGE_SIZE when omitted (or NaN), otherwise floored to an integer
    and clamped to [1, MAX_LINEAGE_PAGE_SIZE]. The floor at 1 means a page always advances its own cursor."""
    if page_size is None or math.isnan(page_size):
        return DEFAULT_LINEAGE_PAGE_SIZE
    if math.isinf(page_size):
        return MAX_LINEAGE_PAGE_SIZE if page_size > 0 else 1
    return max(1, min(math.floor(page_size), MAX_LINEAGE_PAGE_SIZE))


class LineageCursorError(ValueError):
    """Raised by decode_seq_cursor when a cursor string is not one this codec produced."""

    def __init__(self, cursor: str, reason: str) -> None:
        super().__init__(f'invalid lineage cursor "{cursor}": {reason}')


def encode_seq_cursor(seq: int) -> str:
    """Encodes seq (an adapter-defined, monotonically increasing append-order position -- a 1-based
    list/line index, a DB `bigserial`, a Redis `INCR` counter) as the opaque cursor string
    LineagePage.nextCursor / LineagePageRequest.cursor carry on the wire."""
    payload = json.dumps({"v": 1, "seq": seq}, separators=(",", ":"))
    encoded = base64.urlsafe_b64encode(payload.encode("ascii")).decode("ascii")
    return encoded.rstrip("=")  # unpadded, matching the TS codec's base64url output


def decode_seq_cursor(cursor: str) -> int:
    """Decodes a cursor produced by encode_seq_cursor (from either language). Raises LineageCursorError for
    anything else: malformed base64url, invalid JSON, the wrong shape, an unsupported `v`, or a `seq` that
    is not a non-negative safe integer (0 <= seq <= 2**53 - 1, the same bound TS's Number.isSafeInteger
    enforces). Every real seq value in this codebase (a list index, a line number, a bigserial, an INCR
    counter) satisfies that, so this only rejects a cursor no real encoder on either side could have
    produced -- a fractional or negative one would otherwise rewind or duplicate a page.
    """
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except Exception as e:
        raise LineageCursorError(cursor, "not valid base64url") from e
    try:
        parsed: Any = json.loads(raw)
    except Exception as e:
        raise LineageCursorError(cursor, "does not decode to JSON") from e
    seq = parsed.get("seq") if isinstance(parsed, dict) else None
    if (
        not isinstance(parsed, dict)
        or parsed.get("v") != 1
        or not isinstance(seq, (int, float))
        or isinstance(seq, bool)
        or (isinstance(seq, float) and not (math.isfinite(seq) and seq.is_integer()))
        or seq < 0
        or seq > _MAX_SAFE_INTEGER
    ):
        raise LineageCursorError(cursor, 'expected {"v":1,"seq":<non-negative integer>}')
    return int(seq)


def _matches(event: LineageEventRecord, req: LineagePageRequest) -> bool:
    """The per-event predicate `page_lineage_events` applies (mirrors FileStoragePort.list_lineage's own
    inline filtering -- kept duplicated rather than factored into a shared helper, matching that method's
    existing style, since Python has no dedicated lineage-filter module to share it from)."""
    if req.type is not None and event.type not in req.type:
        return False
    if req.tenant is not None and event.tenant != req.tenant:
        return False
    if req.intentHash is not None and event.payload.get("intentHash") != req.intentHash:
        return False
    if req.artifactId is not None and event.payload.get("artifactId") != req.artifactId:
        return False
    if req.specHash is not None and event.payload.get("specHash") != req.specHash:
        return False
    if req.correlationId is not None and event.payload.get("correlationId") != req.correlationId:
        return False
    if req.since is not None and event.ts < req.since:
        return False
    if req.until is not None and event.ts > req.until:
        return False
    return True


def page_lineage_events(events: list[LineageEventRecord], req: LineagePageRequest) -> LineagePage:
    """`StoragePort.page_lineage` for an adapter that already keeps its whole lineage log as a plain
    append-ordered list (port of TS lineage-page.ts's pageLineageArray). `seq` is 1-based position in
    `events` (FileStoragePort's `seq` is, by construction, its `lineage.jsonl` line number, since every
    append writes the line and appends to the list in lockstep, and a restart reloads the list in file
    order).

    Scans forward from `req.cursor` (or the start), applying every predicate `req` carries (`_matches`),
    and collects up to `page_size` matches (default DEFAULT_LINEAGE_PAGE_SIZE, clamped to
    MAX_LINEAGE_PAGE_SIZE by clamp_lineage_page_size; also floored at 1 so a `page_size` of 0 or less can never produce a page whose
    `nextCursor` fails to advance, which would otherwise strand a caller looping on `nextCursor` forever).
    `nextCursor` is set to the last returned event's own seq only when at least one further match exists
    beyond the page (detected by scanning one match past `page_size` before trimming) -- so the last page
    always omits it.
    """
    page_size = clamp_lineage_page_size(req.pageSize)
    after_seq = decode_seq_cursor(req.cursor) if req.cursor is not None else 0

    matches: list[LineageEventRecord] = []
    last_seq = after_seq
    has_more = False
    for i in range(after_seq, len(events)):
        event = events[i]
        if not _matches(event, req):
            continue
        if len(matches) == page_size:
            has_more = True
            break
        matches.append(event)
        last_seq = i + 1
    if has_more:
        return LineagePage(events=matches, nextCursor=encode_seq_cursor(last_seq))
    return LineagePage(events=matches)
