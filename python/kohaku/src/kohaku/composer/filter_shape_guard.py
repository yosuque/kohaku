"""Defence in depth for `ComposePolicy.l1Filters` (port of TS filter-shape-guard.ts; design.md #78).

Drops every descriptor whose options would CHANGE THE RESULT'S COLUMN NAMES. An injected filter only swaps the
value of a bound query parameter, so a generated component's `x` / `y` / `columns` props keep naming the
columns of the initial variant; a filter that renames the measure (metric), the time column (granularity) or
the dimension (groupBy) would leave the chart or table pointing at columns the new variant no longer returns
(a blank view). The primary guard is a facet declared `filterable=False` (`kohaku.intents`); this catches a
descriptor from a port or an Intent that did not declare it.

The check uses `SemanticPort.describe_shape` (column metadata, never rows -- the same method the chart-kind
rule uses): for every handle a descriptor governs (its path is in `paths`, its `queryParam` is in the ref) the
variant ref of each option is described and compared with the handle's own shape (`shapes_by_ref`, set
equality of the column names). A descriptor is dropped when any variant differs or its shape cannot be
obtained (a variant that does not resolve is not safe to offer). A descriptor is kept as-is, unchecked, when
there is nothing to compare against: the governed handle's own shape is unknown (a port without shapes must
mark shape-changing facets `filterable=False`).
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence

from kohaku.spec import (
    DataShape,
    FilterDescriptor,
    QueryHandle,
    format_query_ref,
    parse_query_ref,
)


def _same_columns(a: DataShape, b: DataShape) -> bool:
    """Set equality of the column names (column order is not a shape change)."""
    return {c.name for c in a.columns} == {c.name for c in b.columns}


async def drop_shape_changing_filters(
    descriptors: list[FilterDescriptor],
    handles: Sequence[QueryHandle],
    shapes_by_ref: Mapping[str, DataShape],
    describe_shape: Callable[[QueryHandle], Awaitable[DataShape | None]],
) -> list[FilterDescriptor]:
    """Returns `descriptors` itself when nothing was dropped."""
    if len(descriptors) == 0:
        return descriptors
    # One describe_shape call per distinct variant ref, whatever the number of descriptors / handles asking.
    memo: dict[str, asyncio.Task[DataShape | None]] = {}

    async def _describe(handle: QueryHandle) -> DataShape | None:
        try:
            return await describe_shape(handle)
        except Exception:  # noqa: BLE001 - an unobtainable shape is a "drop", never a compose failure
            return None

    def _shape_of(handle: QueryHandle) -> asyncio.Task[DataShape | None]:
        task = memo.get(handle.uri)
        if task is None:
            task = asyncio.ensure_future(_describe(handle))
            memo[handle.uri] = task
        return task

    async def _keep(descriptor: FilterDescriptor) -> bool:
        paths = descriptor.paths if isinstance(descriptor.paths, list) else []
        for handle in handles:
            try:
                ref = parse_query_ref(handle.uri)
            except Exception:  # noqa: BLE001 - mirrors TS's try/catch: an unparsable ref governs nothing
                continue
            if ref.path not in paths or descriptor.queryParam not in ref.params:
                continue
            base = shapes_by_ref.get(handle.uri)
            if base is None:
                continue  # nothing to compare against
            current = ref.params[descriptor.queryParam]
            for option in descriptor.options:
                if option.value == current:
                    continue
                variant_uri = format_query_ref(
                    source=ref.source,
                    path=ref.path,
                    params={**ref.params, descriptor.queryParam: option.value},
                )
                shape = await _shape_of(QueryHandle(uri=variant_uri))
                if shape is None or not _same_columns(base, shape):
                    return False
        return True

    verdicts = await asyncio.gather(*(_keep(d) for d in descriptors))
    if all(verdicts):
        return descriptors
    return [d for d, keep in zip(descriptors, verdicts, strict=True) if keep]
