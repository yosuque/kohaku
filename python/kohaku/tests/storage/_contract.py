"""The StoragePort contract every adapter must satisfy (Python mirror of the TS `@kohaku-ui/port-contracts`
`describeStoragePortContract`, packages/port-contracts/src/storage.ts, with every optional extension opted in:
`requirePaging`, `requirePutPromotionStates`, `requireDeleteFixation`, `requireCompareAndSet`).

Cases are plain async functions registered with `@_case(name)` in the order of the TS suite, named after its `it(...)`
titles. ``test_storage_contract.py`` runs each case against every adapter (memory / file / redis / postgres) with
pytest's parametrize, one fresh port per case so tests never share state. Every case receives the port under test
as ``Any`` because the optional extensions (`page_lineage`, `put_promotion_states`) are deliberately not members of
the `StoragePort` Protocol.

The TTL case waits real wall-clock time on every adapter (the TS suite's ``clock: "real"`` mode): the Redis ``EX`` and
Postgres ``now()`` expiries are server-side, and the file/memory ports read ``time.time()``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, cast

import pytest

from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageCursorError,
    LineageEventRecord,
    LineageFilter,
    LineagePageRequest,
    Principal,
    PromotionState,
    StorageConflictError,
    UISpec,
    encode_seq_cursor,
    supports_compare_and_set,
)


@dataclass(frozen=True)
class ContractCase:
    name: str
    run: Callable[[Any], Awaitable[None]]


CASES: list[ContractCase] = []


def _case(
    name: str,
) -> Callable[[Callable[[Any], Awaitable[None]]], Callable[[Any], Awaitable[None]]]:
    def register(fn: Callable[[Any], Awaitable[None]]) -> Callable[[Any], Awaitable[None]]:
        CASES.append(ContractCase(name, fn))
        return fn

    return register


def spec(id_: str) -> UISpec:
    """A valid Spec that differs per `id_` (through dataVersion), so equality checks can tell two apart."""
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": {"canonical": "contract.intent", "params": {}, "hash": "sha256:" + "0" * 64},
            "dataVersion": id_,
            "components": [{"id": "root", "type": "layout.stack", "props": {}}],
            "provenance": {"tier": "L0", "composedBy": "contract", "cache": "miss"},
        }
    )


def fixation(
    intent_hash: str, tenant: str | None = None, revision: str | None = None
) -> FixationRecord:
    return FixationRecord(
        intentHash=intent_hash,
        canonical="contract.intent",
        structureHash="sha256:contract",
        pinnedSpec=spec(intent_hash),
        fixatedAt="2026-01-01T00:00:00.000Z",
        approver=Principal(id="contract"),
        tenant=tenant,
        revision=revision,
    )


def promotion(
    artifact_id: str,
    tenant: str | None = None,
    revision: str | None = None,
    status: str = "candidate",
) -> PromotionState:
    return PromotionState(
        artifactId=artifact_id,
        status=status,
        updatedAt="2026-01-01T00:00:00.000Z",
        data={},
        tenant=tenant,
        revision=revision,
    )


def event(
    type_: str, payload: dict[str, Any], ts: str, tenant: str | None = None
) -> LineageEventRecord:
    return LineageEventRecord(
        id=f"{type_}:{ts}:{tenant or ''}",
        ts=ts,
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload,
        tenant=tenant,
    )


def ids(events: list[LineageEventRecord]) -> list[str]:
    return [e.id for e in events]


# ---------------------------------------------------------------------------------------------------------------
# spec cache
# ---------------------------------------------------------------------------------------------------------------


@_case("spec cache: misses an unknown key and hits a stored one")
async def _spec_cache_hit_and_miss(port: Any) -> None:
    assert await port.get_spec_cache("missing") is None
    await port.put_spec_cache("k", spec("a"))
    assert await port.get_spec_cache("k") == spec("a")


@_case("spec cache: overwrites on put with the same key")
async def _spec_cache_overwrite(port: Any) -> None:
    await port.put_spec_cache("k", spec("a"))
    await port.put_spec_cache("k", spec("b"))
    assert await port.get_spec_cache("k") == spec("b")


@_case("spec cache: expires an entry once ttl_seconds has elapsed")
async def _spec_cache_ttl(port: Any) -> None:
    await port.put_spec_cache("k", spec("a"), ttl_seconds=1)
    assert await port.get_spec_cache("k") == spec("a")
    await asyncio.sleep(1.1)
    assert await port.get_spec_cache("k") is None


# ---------------------------------------------------------------------------------------------------------------
# lineage
# ---------------------------------------------------------------------------------------------------------------

_E1 = event(
    "view.composed",
    {"intentHash": "h1", "artifactId": "a1", "specHash": "s1", "correlationId": "c1"},
    "2026-01-01T00:00:00.000Z",
    "t1",
)
_E2 = event(
    "view.composed",
    {"intentHash": "h2", "artifactId": "a2", "specHash": "s2", "correlationId": "c2"},
    "2026-01-02T00:00:00.000Z",
    "t2",
)
_E3 = event(
    "component.used",
    {"intentHash": "h1", "artifactId": "a1", "specHash": "s1", "correlationId": "c1"},
    "2026-01-03T00:00:00.000Z",
    "t1",
)


async def _seed_lineage(port: Any) -> None:
    for e in (_E1, _E2, _E3):
        await port.append_lineage(e)


@_case("lineage: lists in append order without a filter")
async def _lineage_append_order(port: Any) -> None:
    await _seed_lineage(port)
    assert ids(await port.list_lineage()) == [_E1.id, _E2.id, _E3.id]


@_case("lineage: filters by type, tenant, intentHash, artifactId, specHash, correlationId")
async def _lineage_filters(port: Any) -> None:
    await _seed_lineage(port)
    assert ids(await port.list_lineage(LineageFilter(type=["component.used"]))) == [_E3.id]
    assert ids(await port.list_lineage(LineageFilter(tenant="t1"))) == [_E1.id, _E3.id]
    assert ids(await port.list_lineage(LineageFilter(intentHash="h2"))) == [_E2.id]
    assert ids(await port.list_lineage(LineageFilter(artifactId="a2"))) == [_E2.id]
    assert ids(await port.list_lineage(LineageFilter(specHash="s1"))) == [_E1.id, _E3.id]
    assert ids(await port.list_lineage(LineageFilter(correlationId="c1"))) == [_E1.id, _E3.id]


@_case("lineage: applies since / until inclusively and limit as a tail window; limit <= 0 is empty")
async def _lineage_window(port: Any) -> None:
    await _seed_lineage(port)
    assert ids(await port.list_lineage(LineageFilter(since="2026-01-02T00:00:00.000Z"))) == [
        _E2.id,
        _E3.id,
    ]
    assert ids(await port.list_lineage(LineageFilter(until="2026-01-02T00:00:00.000Z"))) == [
        _E1.id,
        _E2.id,
    ]
    assert ids(await port.list_lineage(LineageFilter(limit=2))) == [_E2.id, _E3.id]
    assert await port.list_lineage(LineageFilter(limit=0)) == []
    assert await port.list_lineage(LineageFilter(limit=-1)) == []


@_case("lineage: treats an empty-string tenant filter as unspecified (matches every event)")
async def _lineage_empty_tenant(port: Any) -> None:
    await _seed_lineage(port)
    assert ids(await port.list_lineage(LineageFilter(tenant=""))) == [_E1.id, _E2.id, _E3.id]


@_case("lineage: appending an event with an id that already exists is idempotent")
async def _lineage_idempotent(port: Any) -> None:
    await _seed_lineage(port)
    await port.append_lineage(
        LineageEventRecord(
            id=_E1.id,
            ts=_E1.ts,
            actor=_E1.actor,
            type=_E1.type,
            payload={**_E1.payload, "specHash": "mutated"},
            tenant=_E1.tenant,
        )
    )
    everything = await port.list_lineage()
    assert ids(everything) == [_E1.id, _E2.id, _E3.id]
    assert next(e for e in everything if e.id == _E1.id).payload["specHash"] == "s1"


@_case("oversized correlationId: stays filterable and unmodified (4 KB)")
async def _oversized_correlation_id(port: Any) -> None:
    long = "req-" + "x" * 4096
    other = long + "y"
    with_long = event("view.render", {"correlationId": long}, "2026-01-05T00:00:00.000Z")
    with_other = event("view.render", {"correlationId": other}, "2026-01-05T00:00:01.000Z")
    await port.append_lineage(with_long)
    await port.append_lineage(with_other)
    listed = await port.list_lineage(LineageFilter(correlationId=long))
    assert ids(listed) == [with_long.id]
    assert listed[0].payload["correlationId"] == long
    assert ids(await port.list_lineage(LineageFilter(correlationId=other))) == [with_other.id]
    page = await port.page_lineage(LineagePageRequest(correlationId=long))
    assert ids(page.events) == [with_long.id]


# ---------------------------------------------------------------------------------------------------------------
# page_lineage (optional forward-paging extension, design.md #53)
# ---------------------------------------------------------------------------------------------------------------

_P1 = event(
    "view.composed",
    {"intentHash": "h1", "correlationId": "c1"},
    "2026-01-01T00:00:00.000Z",
    "t1",
)
_P2 = event(
    "view.composed",
    {"intentHash": "h2", "correlationId": "c2"},
    "2026-01-02T00:00:00.000Z",
    "t2",
)
_P3 = event(
    "component.used",
    {"intentHash": "h3", "correlationId": "c1"},
    "2026-01-03T00:00:00.000Z",
    "t1",
)
_P4 = event(
    "view.composed",
    {"intentHash": "h4", "correlationId": "c3"},
    "2026-01-04T00:00:00.000Z",
    "t1",
)


async def _seed_paging(port: Any) -> None:
    for e in (_P1, _P2, _P3, _P4):
        await port.append_lineage(e)


@_case("page_lineage: is implemented by the port under test")
async def _page_implemented(port: Any) -> None:
    assert callable(getattr(port, "page_lineage", None))


@_case("page_lineage: returns pages in ascending append order with no gaps or duplicates")
async def _page_ascending(port: Any) -> None:
    await _seed_paging(port)
    page1 = await port.page_lineage(LineagePageRequest(pageSize=2))
    assert ids(page1.events) == [_P1.id, _P2.id]
    assert page1.nextCursor is not None
    page2 = await port.page_lineage(LineagePageRequest(pageSize=2, cursor=page1.nextCursor))
    assert ids(page2.events) == [_P3.id, _P4.id]
    assert page2.nextCursor is None


@_case(
    "page_lineage: an event appended between two page reads is visible on a later page without "
    "disturbing earlier ones"
)
async def _page_append_between(port: Any) -> None:
    await _seed_paging(port)
    page1 = await port.page_lineage(LineagePageRequest(pageSize=3))
    assert ids(page1.events) == [_P1.id, _P2.id, _P3.id]
    assert page1.nextCursor is not None
    p5 = event("view.composed", {"intentHash": "h5"}, "2026-01-05T00:00:00.000Z")
    await port.append_lineage(p5)
    page2 = await port.page_lineage(LineagePageRequest(pageSize=3, cursor=page1.nextCursor))
    assert ids(page2.events) == [_P4.id, p5.id]
    assert page2.nextCursor is None


@_case("page_lineage: combines with a filter predicate (correlationId)")
async def _page_filter(port: Any) -> None:
    await _seed_paging(port)
    page = await port.page_lineage(LineagePageRequest(correlationId="c1"))
    assert ids(page.events) == [_P1.id, _P3.id]
    assert page.nextCursor is None


@_case("page_lineage: combines with the tenant filter")
async def _page_tenant(port: Any) -> None:
    await _seed_paging(port)
    page = await port.page_lineage(LineagePageRequest(tenant="t1"))
    assert ids(page.events) == [_P1.id, _P3.id, _P4.id]


@_case("page_lineage: truncates an oversized page_size to the 1000 cap instead of rejecting it")
async def _page_oversized(port: Any) -> None:
    await _seed_paging(port)
    page = await port.page_lineage(LineagePageRequest(pageSize=1_000_000))
    assert len(page.events) == 4
    assert page.nextCursor is None


@_case("page_lineage: floors a fractional page_size to an integer")
async def _page_fractional(port: Any) -> None:
    await _seed_paging(port)
    page = await port.page_lineage(LineagePageRequest(pageSize=cast(Any, 2.5)))
    assert len(page.events) == 2
    assert page.nextCursor is not None


@_case("page_lineage: raises for a malformed cursor instead of restarting or skipping silently")
async def _page_malformed_cursor(port: Any) -> None:
    await _seed_paging(port)
    with pytest.raises(LineageCursorError):
        await port.page_lineage(LineagePageRequest(cursor="not-a-real-cursor"))


@_case(
    "page_lineage: rejects a well-formed cursor whose seq is fractional, negative or beyond the "
    "safe-integer range"
)
async def _page_bad_seq(port: Any) -> None:
    await _seed_paging(port)
    for seq in (0.5, -1, 2**53, 1e300):
        with pytest.raises(LineageCursorError):
            await port.page_lineage(LineagePageRequest(cursor=encode_seq_cursor(cast(Any, seq))))


# ---------------------------------------------------------------------------------------------------------------
# promotion states
# ---------------------------------------------------------------------------------------------------------------


@_case(
    "promotion states: keys by (tenant, artifactId): tenant-less and tenant-scoped do not collide"
)
async def _promotion_keys(port: Any) -> None:
    await port.put_promotion_state(promotion("x"))
    await port.put_promotion_state(promotion("x", "a"))
    assert await port.get_promotion_state("x") == promotion("x")
    assert await port.get_promotion_state("x", "a") == promotion("x", "a")
    assert await port.get_promotion_state("x", "b") is None


@_case("promotion states: overwrites on put and lists per tenant (unspecified tenant = all)")
async def _promotion_overwrite_and_list(port: Any) -> None:
    await port.put_promotion_state(promotion("x", "a"))
    await port.put_promotion_state(promotion("x", "a", status="approved"))
    await port.put_promotion_state(promotion("y", "b"))
    state = await port.get_promotion_state("x", "a")
    assert state is not None
    assert state.status == "approved"
    assert [s.artifactId for s in await port.list_promotion_states("a")] == ["x"]
    assert sorted(s.artifactId for s in await port.list_promotion_states()) == ["x", "y"]


@_case("promotion states: put_promotion_states (optional) is equivalent to putting each state")
async def _promotion_batch(port: Any) -> None:
    await port.put_promotion_states([promotion("x", "a"), promotion("y", "a")])
    assert sorted(s.artifactId for s in await port.list_promotion_states("a")) == ["x", "y"]


@_case(
    "promotion states: treats an empty-string tenant as equivalent to unspecified for get/put/list"
)
async def _promotion_empty_tenant(port: Any) -> None:
    await port.put_promotion_state(promotion("x", ""))
    stored = await port.get_promotion_state("x")
    assert stored is not None
    assert stored.artifactId == "x"
    assert await port.get_promotion_state("x", "") == stored
    assert [s.artifactId for s in await port.list_promotion_states("")] == [
        s.artifactId for s in await port.list_promotion_states()
    ]


# ---------------------------------------------------------------------------------------------------------------
# compare-and-set (optional extension)
# ---------------------------------------------------------------------------------------------------------------


async def _expect_conflict(awaitable: Awaitable[Any]) -> None:
    with pytest.raises(StorageConflictError):
        await awaitable


async def _race(a: Awaitable[Any], b: Awaitable[Any]) -> tuple[int, int]:
    """Settles two concurrent writes and returns (how many resolved, how many raised a conflict)."""
    settled = await asyncio.gather(a, b, return_exceptions=True)
    ok = conflict = 0
    for result in settled:
        if isinstance(result, StorageConflictError):
            conflict += 1
        elif isinstance(result, BaseException):
            raise result
        else:
            ok += 1
    return ok, conflict


async def _promo(port: Any, artifact_id: str, tenant: str | None = None) -> PromotionState:
    state = await port.get_promotion_state(artifact_id, tenant)
    assert state is not None
    return cast(PromotionState, state)


async def _fix(port: Any, intent_hash: str, tenant: str | None = None) -> FixationRecord:
    record = await port.get_fixation(intent_hash, tenant)
    assert record is not None
    return cast(FixationRecord, record)


DECLARES_CAS_CASE = "compare-and-set: declares supports_compare_and_set (or deliberately does not)"
"""The one case whose expectation depends on the adapter: the runner (test_storage_contract.py) inverts it for a
single-process adapter that honors `expected_revision` but deliberately does not declare the extension (the TS
suite's `declaresCompareAndSet: false`). Every other compare-and-set case runs on every adapter, declaring or not."""


@_case(DECLARES_CAS_CASE)
async def _cas_declares(port: Any) -> None:
    assert supports_compare_and_set(port)


@_case(
    "compare-and-set: put_promotion_state: an exact expected_revision succeeds, a stale one raises "
    "and writes nothing"
)
async def _cas_promotion_exact(port: Any) -> None:
    await port.put_promotion_state(promotion("x", "a", "r1"), expected_revision=None)
    await port.put_promotion_state(
        promotion("x", "a", "r2", status="approved"), expected_revision="r1"
    )
    assert (await _promo(port, "x", "a")).revision == "r2"
    await _expect_conflict(
        port.put_promotion_state(
            promotion("x", "a", "r3", status="rejected"), expected_revision="r1"
        )
    )
    stored = await _promo(port, "x", "a")
    assert stored.revision == "r2"
    assert stored.status == "approved"


@_case("compare-and-set: put_promotion_state: None means the state must not exist yet")
async def _cas_promotion_none(port: Any) -> None:
    await port.put_promotion_state(promotion("x", "a", "r1"), expected_revision=None)
    await _expect_conflict(
        port.put_promotion_state(promotion("x", "a", "r2"), expected_revision=None)
    )
    assert (await _promo(port, "x", "a")).revision == "r1"
    # Another tenant's state is a different key, so None is satisfied there.
    await port.put_promotion_state(promotion("x", "b", "r1"), expected_revision=None)


@_case(
    "compare-and-set: put_promotion_state: a str expectation against an absent state conflicts and "
    "creates nothing"
)
async def _cas_promotion_absent(port: Any) -> None:
    await _expect_conflict(
        port.put_promotion_state(promotion("x", "a", "r2"), expected_revision="r1")
    )
    assert await port.get_promotion_state("x", "a") is None


@_case(
    "compare-and-set: put_promotion_state: an omitted expected_revision stays unconditional, "
    "including over a legacy record"
)
async def _cas_promotion_unconditional(port: Any) -> None:
    await port.put_promotion_state(promotion("x", "a"))  # a record that predates `revision`
    await port.put_promotion_state(promotion("x", "a", "r1"))  # unconditional: upgrades it
    await port.put_promotion_state(promotion("x", "a", "r2"))
    assert (await _promo(port, "x", "a")).revision == "r2"
    # A str expectation never matches a record that carries no revision.
    await port.put_promotion_state(promotion("y", "a"))
    await _expect_conflict(
        port.put_promotion_state(promotion("y", "a", "r2"), expected_revision="r1")
    )


@_case(
    'compare-and-set: put_promotion_state: "" means the record exists but carries no revision '
    "(matches only an unversioned record)"
)
async def _cas_promotion_empty_string(port: Any) -> None:
    # Matches a record that predates `revision`, and the write proceeds.
    await port.put_promotion_state(promotion("x", "a"))
    await port.put_promotion_state(
        promotion("x", "a", "r1", status="approved"), expected_revision=""
    )
    assert (await _promo(port, "x", "a")).revision == "r1"
    # Once the record is versioned, "" conflicts and writes nothing.
    await _expect_conflict(
        port.put_promotion_state(promotion("x", "a", "r2", status="rejected"), expected_revision="")
    )
    stored = await _promo(port, "x", "a")
    assert stored.revision == "r1"
    assert stored.status == "approved"
    # An absent record conflicts too (it is neither "absent" (None) nor "unversioned").
    await _expect_conflict(
        port.put_promotion_state(promotion("x", "b", "r1"), expected_revision="")
    )
    assert await port.get_promotion_state("x", "b") is None


@_case(
    'compare-and-set: put_promotion_state: of two concurrent writes from the same unversioned base ("") '
    "exactly one wins"
)
async def _cas_promotion_empty_string_race(port: Any) -> None:
    await port.put_promotion_state(promotion("x", "a"))
    outcome = await _race(
        port.put_promotion_state(
            promotion("x", "a", "rA", status="approved"), expected_revision=""
        ),
        port.put_promotion_state(
            promotion("x", "a", "rB", status="rejected"), expected_revision=""
        ),
    )
    assert outcome == (1, 1)


@_case(
    "compare-and-set: put_promotion_state: of two concurrent writes from the same base, exactly one wins"
)
async def _cas_promotion_race(port: Any) -> None:
    await port.put_promotion_state(promotion("x", "a", "r1"))
    outcome = await _race(
        port.put_promotion_state(
            promotion("x", "a", "rA", status="approved"), expected_revision="r1"
        ),
        port.put_promotion_state(
            promotion("x", "a", "rB", status="rejected"), expected_revision="r1"
        ),
    )
    assert outcome == (1, 1)
    stored = await _promo(port, "x", "a")
    assert stored.status == ("approved" if stored.revision == "rA" else "rejected")


@_case(
    "compare-and-set: put_fixation: an exact expected_revision succeeds, a stale one raises and "
    "writes nothing"
)
async def _cas_fixation_exact(port: Any) -> None:
    await port.put_fixation(fixation("h", "a", "r1"), expected_revision=None)
    await port.put_fixation(fixation("h", "a", "r2"), expected_revision="r1")
    assert (await _fix(port, "h", "a")).revision == "r2"
    await _expect_conflict(port.put_fixation(fixation("h", "a", "r3"), expected_revision="r1"))
    assert (await _fix(port, "h", "a")).revision == "r2"


@_case(
    "compare-and-set: put_fixation: None conflicts with an existing fixation; a str conflicts with an "
    "absent one"
)
async def _cas_fixation_none_and_absent(port: Any) -> None:
    await _expect_conflict(port.put_fixation(fixation("h", "a", "r2"), expected_revision="r1"))
    assert await port.get_fixation("h", "a") is None
    await port.put_fixation(fixation("h", "a", "r1"), expected_revision=None)
    await _expect_conflict(port.put_fixation(fixation("h", "a", "r2"), expected_revision=None))
    assert (await _fix(port, "h", "a")).revision == "r1"


@_case(
    "compare-and-set: put_fixation: if_present combines with expected_revision (absent = silent "
    "no-op, present = compared)"
)
async def _cas_fixation_if_present(port: Any) -> None:
    # Absent: if_present wins, so even a str expectation is a no-op rather than a conflict.
    await port.put_fixation(fixation("h", "a", "r2"), if_present=True, expected_revision="r1")
    assert await port.get_fixation("h", "a") is None
    # Present: the revision is compared.
    await port.put_fixation(fixation("h", "a", "r1"))
    await port.put_fixation(fixation("h", "a", "r2"), if_present=True, expected_revision="r1")
    assert (await _fix(port, "h", "a")).revision == "r2"
    await _expect_conflict(
        port.put_fixation(fixation("h", "a", "r3"), if_present=True, expected_revision="r1")
    )
    assert (await _fix(port, "h", "a")).revision == "r2"


@_case(
    "compare-and-set: put_fixation: if_present with expected_revision None is contradictory and "
    "always conflicts"
)
async def _cas_fixation_if_present_none(port: Any) -> None:
    await _expect_conflict(
        port.put_fixation(fixation("h", "a", "r1"), if_present=True, expected_revision=None)
    )
    await port.put_fixation(fixation("h", "a", "r1"))
    await _expect_conflict(
        port.put_fixation(fixation("h", "a", "r2"), if_present=True, expected_revision=None)
    )
    assert (await _fix(port, "h", "a")).revision == "r1"


@_case(
    "compare-and-set: put_fixation: of two concurrent writes from the same base, exactly one wins"
)
async def _cas_fixation_race(port: Any) -> None:
    await port.put_fixation(fixation("h", "a", "r1"))
    outcome = await _race(
        port.put_fixation(fixation("h", "a", "rA"), expected_revision="r1"),
        port.put_fixation(fixation("h", "a", "rB"), expected_revision="r1"),
    )
    assert outcome == (1, 1)


@_case(
    'compare-and-set: put_fixation / delete_fixation: "" matches only a fixation that carries no revision '
    "(conflicts with a versioned or absent one)"
)
async def _cas_fixation_empty_string(port: Any) -> None:
    await port.put_fixation(fixation("h", "a"))  # predates `revision`
    await port.put_fixation(fixation("h", "a", "r1"), expected_revision="")
    assert (await _fix(port, "h", "a")).revision == "r1"
    await _expect_conflict(port.put_fixation(fixation("h", "a", "r2"), expected_revision=""))
    await _expect_conflict(port.delete_fixation("h", "a", expected_revision=""))
    assert (await _fix(port, "h", "a")).revision == "r1"
    # if_present + "": applied to a present unversioned record, a silent no-op on an absent one.
    await port.put_fixation(fixation("h", "b"))  # unversioned
    await port.put_fixation(fixation("h", "b", "r1"), if_present=True, expected_revision="")
    assert (await _fix(port, "h", "b")).revision == "r1"
    await port.put_fixation(fixation("h", "c", "r1"), if_present=True, expected_revision="")
    assert await port.get_fixation("h", "c") is None
    # An absent record conflicts without if_present, and deleting an unversioned one with "" works.
    await _expect_conflict(port.put_fixation(fixation("h", "c", "r1"), expected_revision=""))
    await _expect_conflict(port.delete_fixation("h", "c", expected_revision=""))
    await port.put_fixation(fixation("h", "d"))
    await port.delete_fixation("h", "d", expected_revision="")
    assert await port.get_fixation("h", "d") is None


@_case(
    "compare-and-set: delete_fixation: expected_revision deletes on a match and raises on a mismatch"
)
async def _cas_delete(port: Any) -> None:
    await port.put_fixation(fixation("h", "a", "r1"))
    await _expect_conflict(port.delete_fixation("h", "a", expected_revision="r0"))
    assert await port.get_fixation("h", "a") is not None
    await port.delete_fixation("h", "a", expected_revision="r1")
    assert await port.get_fixation("h", "a") is None


@_case(
    "compare-and-set: delete_fixation: a str expectation against an absent fixation conflicts; "
    "without one it stays a no-op"
)
async def _cas_delete_absent(port: Any) -> None:
    await _expect_conflict(port.delete_fixation("h", "a", expected_revision="r1"))
    await port.delete_fixation("h", "a")


@_case("compare-and-set: delete_fixation: a delete and a write from the same base cannot both land")
async def _cas_delete_race(port: Any) -> None:
    await port.put_fixation(fixation("h", "a", "r1"))
    outcome = await _race(
        port.delete_fixation("h", "a", expected_revision="r1"),
        port.put_fixation(fixation("h", "a", "r2"), expected_revision="r1"),
    )
    assert outcome == (1, 1)


@_case("compare-and-set: scopes the check by tenant: another tenant's revision is never consulted")
async def _cas_tenant_scope(port: Any) -> None:
    await port.put_fixation(fixation("h", "a", "r1"))
    await port.put_fixation(fixation("h", "b", "r9"))
    await port.put_fixation(fixation("h", "a", "r2"), expected_revision="r1")
    assert (await _fix(port, "h", "b")).revision == "r9"


# ---------------------------------------------------------------------------------------------------------------
# fixations
# ---------------------------------------------------------------------------------------------------------------


@_case("fixations: keys by (tenant, intentHash) and lists per tenant")
async def _fixation_keys(port: Any) -> None:
    await port.put_fixation(fixation("h"))
    await port.put_fixation(fixation("h", "a"))
    assert await port.get_fixation("h") == fixation("h")
    assert await port.get_fixation("h", "a") == fixation("h", "a")
    assert await port.get_fixation("h", "b") is None
    assert [f.intentHash for f in await port.list_fixations("a")] == ["h"]
    assert len(await port.list_fixations()) == 2


@_case("fixations: if_present updates an existing record and never creates one")
async def _fixation_if_present(port: Any) -> None:
    await port.put_fixation(fixation("h", "a"), if_present=True)
    assert await port.get_fixation("h", "a") is None
    await port.put_fixation(fixation("h", "a"))
    await port.put_fixation(fixation("h", "a", "2"), if_present=True)
    assert (await _fix(port, "h", "a")).revision == "2"


@_case("fixations: delete_fixation (optional) removes only that (tenant, intentHash)")
async def _fixation_delete(port: Any) -> None:
    await port.put_fixation(fixation("h", "a"))
    await port.put_fixation(fixation("h", "b"))
    await port.delete_fixation("h", "a")
    assert await port.get_fixation("h", "a") is None
    assert await port.get_fixation("h", "b") is not None


@_case("fixations: treats an empty-string tenant as equivalent to unspecified for get/put/list")
async def _fixation_empty_tenant(port: Any) -> None:
    await port.put_fixation(fixation("h", ""))
    stored = await port.get_fixation("h")
    assert stored is not None
    assert stored.intentHash == "h"
    assert await port.get_fixation("h", "") == stored
    assert [f.intentHash for f in await port.list_fixations("")] == [
        f.intentHash for f in await port.list_fixations()
    ]
