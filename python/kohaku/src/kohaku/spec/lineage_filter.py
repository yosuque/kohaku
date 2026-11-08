"""Lineage filtering shared by every StoragePort (port of packages/spec-core/src/lineage-filter.ts): the default
tail-window size, the payload fields a `LineageFilter` can match, the per-event predicate, and the tail-window
helper. An adapter that keeps a secondary index over lineage (a DB column, a sorted set per value) indexes
exactly `LINEAGE_PAYLOAD_INDEX_FIELDS` and applies `matches_lineage_filter` to whatever its index cannot
express, instead of re-deriving the predicate.
"""

from __future__ import annotations

from .ports import LineageEventRecord, LineageFilter, LineagePageRequest, normalize_tenant

DEFAULT_LINEAGE_LIMIT = 200
"""Default tail-window size for `StoragePort.list_lineage` when `LineageFilter.limit` is omitted. Shared by
every StoragePort implementation, so the number lives in one place (twin of TS's DEFAULT_LINEAGE_LIMIT)."""

LINEAGE_PAYLOAD_INDEX_FIELDS = ("intentHash", "artifactId", "specHash", "correlationId")
"""The `LineageEventRecord.payload` fields a `LineageFilter` can match by exact equality -- the only payload
fields `matches_lineage_filter` ever reads (twin of TS's LINEAGE_PAYLOAD_INDEX_FIELDS, same order)."""


def matches_lineage_filter(
    event: LineageEventRecord, filter: LineageFilter | LineagePageRequest
) -> bool:
    """Whether a single lineage event satisfies every condition of a filter (all ANDed): `type` membership,
    `tenant` equality (after `normalize_tenant` on both sides, so an empty-string tenant on either side
    behaves like an unspecified one), the `intentHash` / `artifactId` / `specHash` / `correlationId` payload
    fields by exact equality, and `since` / `until` inclusive bounds on `ts`. Does not apply `limit` (see
    `apply_lineage_limit`). Twin of TS's matchesLineageFilter."""
    if filter.type is not None and event.type not in filter.type:
        return False
    filter_tenant = normalize_tenant(filter.tenant)
    if filter_tenant is not None and normalize_tenant(event.tenant) != filter_tenant:
        return False
    if filter.intentHash is not None and event.payload.get("intentHash") != filter.intentHash:
        return False
    if filter.artifactId is not None and event.payload.get("artifactId") != filter.artifactId:
        return False
    if filter.specHash is not None and event.payload.get("specHash") != filter.specHash:
        return False
    if (
        filter.correlationId is not None
        and event.payload.get("correlationId") != filter.correlationId
    ):
        return False
    if filter.since is not None and event.ts < filter.since:
        return False
    if filter.until is not None and event.ts > filter.until:
        return False
    return True


def apply_lineage_limit[T](items: list[T], limit: int = DEFAULT_LINEAGE_LIMIT) -> list[T]:
    """The most recent `limit` items of an append-ordered list (a tail slice) -- the shape `list_lineage`
    returns after filtering. `limit <= 0` is an empty list (the trap TS's `slice(-0)` falls into is closed
    here too: Python's `items[-0:]` would also return everything). Twin of TS's applyLineageLimit."""
    if limit <= 0:
        return []
    return items[-limit:]
