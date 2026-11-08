"""schema_edit_examples (design.md #73): the extractor's few-shot provider, mined from the lineage log
(pytest port of packages/lineage/test/promotion-examples.test.ts).

The provider is driven with a hand-rolled StoragePort double whose list_lineage honors type / artifactId / tenant /
limit like the real ports (a tail window in append order), because only that one method is read.
"""

from __future__ import annotations

import asyncio
import itertools
from typing import Any, cast

import pytest

from kohaku.lineage import schema_edit_examples
from kohaku.spec import LineageActor, LineageEventRecord, LineageFilter, StoragePort

_seq = itertools.count()


class _Storage:
    """Only `list_lineage` is implemented; it records every filter it receives."""

    def __init__(self, events: list[LineageEventRecord]) -> None:
        self.events = events
        self.queries: list[LineageFilter] = []
        self.failing = False

    async def list_lineage(self, filter: LineageFilter | None = None) -> list[LineageEventRecord]:
        flt = filter if filter is not None else LineageFilter()
        self.queries.append(flt)
        if self.failing:
            raise RuntimeError("down")
        result = self.events
        if flt.type is not None:
            result = [e for e in result if e.type in flt.type]
        if flt.tenant is not None:
            result = [e for e in result if e.tenant == flt.tenant]
        if flt.artifactId is not None:
            result = [e for e in result if e.payload.get("artifactId") == flt.artifactId]
        limit = flt.limit if flt.limit is not None else 200
        return result[-limit:]


def _storage(events: list[LineageEventRecord]) -> _Storage:
    return _Storage(events)


def _port(storage: _Storage) -> StoragePort:
    return cast("StoragePort", storage)


def ev(
    type_: str, payload: dict[str, Any], ts: str, tenant: str | None = None
) -> LineageEventRecord:
    return LineageEventRecord(
        id=f"ex-{next(_seq)}",
        ts=ts,
        actor=LineageActor(kind="system"),
        type=type_,
        payload=payload,
        tenant=tenant,
    )


def draft(component_type: str, description: str = "d") -> dict[str, Any]:
    return {
        "componentType": component_type,
        "version": "1.0.0",
        "intentName": component_type.replace(".", ".x_"),
        "description": description,
    }


CHANGED = [{"field": "description", "suggested": "a", "final": "b"}]


def reviewed(
    artifact_id: str,
    component_type: str,
    edited_at: str,
    *,
    tenant: str | None = None,
    changed: list[Any] | None = None,
    html: str | None = None,
) -> list[LineageEventRecord]:
    """The four events of one reviewed artifact: generated, suggested, proposed (final), edited."""
    changed_value = CHANGED if changed is None else changed
    html_value = html if html is not None else f"<div>{artifact_id}</div>"
    return [
        ev(
            "component.generated",
            {"artifactId": artifact_id, "html": html_value},
            "2026-07-01T00:00:00.000Z",
            tenant,
        ),
        ev(
            "component.schemaSuggested",
            {
                "artifactId": artifact_id,
                "suggestion": {
                    "draft": draft(f"{component_type}Machine"),
                    "events": [],
                    "confidence": 0.5,
                },
            },
            "2026-07-01T00:01:00.000Z",
            tenant,
        ),
        ev(
            "component.schemaProposed",
            {"artifactId": artifact_id, "draft": draft(component_type)},
            edited_at,
            tenant,
        ),
        ev(
            "component.schemaEdited",
            {
                "artifactId": artifact_id,
                "changed": changed_value,
                "unchanged": [],
                "acknowledged": True,
            },
            edited_at,
            tenant,
        ),
    ]


def types_of(examples: list[Any]) -> list[str]:
    return [e["final"]["componentType"] for e in examples]


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def test_returns_the_corrected_cases_newest_first_joined_with_final_suggestion_and_html() -> None:
    provider = schema_edit_examples(
        _port(
            _storage(
                [
                    *reviewed("a-old", "sales.old", "2026-07-02T00:00:00.000Z"),
                    *reviewed("a-new", "sales.new", "2026-07-03T00:00:00.000Z"),
                ]
            )
        )
    )
    examples = run(provider({}))
    assert types_of(examples) == ["sales.new", "sales.old"]
    assert examples[0] == {
        "final": draft("sales.new"),
        "suggestion": draft("sales.newMachine"),
        "htmlExcerpt": "<div>a-new</div>",
    }


def test_skips_an_accepted_as_is_edit_and_a_case_with_no_final_draft() -> None:
    as_is = reviewed("a-asis", "sales.asIs", "2026-07-05T00:00:00.000Z", changed=[])
    no_final = [
        e
        for e in reviewed("a-nofinal", "sales.noFinal", "2026-07-04T00:00:00.000Z")
        if e.type != "component.schemaProposed"
    ]
    good = reviewed("a-good", "sales.good", "2026-07-03T00:00:00.000Z")
    examples = run(schema_edit_examples(_port(_storage([*good, *no_final, *as_is])))({}))
    assert types_of(examples) == ["sales.good"]


def test_limits_the_result_default_2_after_the_exclusions_newest_first() -> None:
    events = [
        *reviewed("a1", "sales.one", "2026-07-01T10:00:00.000Z"),
        *reviewed("a2", "sales.two", "2026-07-02T10:00:00.000Z"),
        *reviewed("a3", "sales.three", "2026-07-03T10:00:00.000Z", changed=[]),  # skipped, newest
        *reviewed("a4", "sales.four", "2026-07-04T10:00:00.000Z"),
    ]
    storage = _port(_storage(events))
    assert types_of(run(schema_edit_examples(storage)({}))) == ["sales.four", "sales.two"]
    assert types_of(run(schema_edit_examples(storage, limit=1)({}))) == ["sales.four"]
    assert run(schema_edit_examples(storage, limit=0)({})) == []
    assert types_of(run(schema_edit_examples(storage, limit=10)({}))) == [
        "sales.four",
        "sales.two",
        "sales.one",
    ]


def test_uses_the_latest_proposed_draft_and_one_example_per_artifact() -> None:
    events = [
        *reviewed("a1", "sales.first", "2026-07-01T10:00:00.000Z"),
        ev(
            "component.schemaProposed",
            {"artifactId": "a1", "draft": draft("sales.second")},
            "2026-07-02T09:00:00.000Z",
        ),
        ev(
            "component.schemaEdited",
            {"artifactId": "a1", "changed": CHANGED, "unchanged": []},
            "2026-07-02T10:00:00.000Z",
        ),
    ]
    examples = run(schema_edit_examples(_port(_storage(events)))({}))
    assert len(examples) == 1
    assert examples[0]["final"]["componentType"] == "sales.second"


def test_omits_the_optional_parts_not_recorded_and_cuts_the_html_to_1500_characters() -> None:
    events = [
        ev(
            "component.schemaProposed",
            {"artifactId": "bare", "draft": draft("sales.bare")},
            "2026-07-01T00:00:00.000Z",
        ),
        ev(
            "component.schemaEdited",
            {"artifactId": "bare", "changed": CHANGED, "unchanged": []},
            "2026-07-01T00:00:01.000Z",
        ),
        *reviewed("long", "sales.long", "2026-07-02T00:00:00.000Z", html="x" * 1_500 + "TAIL"),
    ]
    long, bare = run(schema_edit_examples(_port(_storage(events)))({}))
    assert bare == {"final": draft("sales.bare")}
    assert long["htmlExcerpt"] == "x" * 1_500


def test_ignores_a_proposed_draft_that_is_not_a_draft() -> None:
    events = [
        ev(
            "component.schemaProposed",
            {"artifactId": "bad", "draft": {"componentType": 3}},
            "2026-07-01T00:00:00.000Z",
        ),
        ev(
            "component.schemaEdited",
            {"artifactId": "bad", "changed": CHANGED, "unchanged": []},
            "2026-07-01T00:00:01.000Z",
        ),
    ]
    assert run(schema_edit_examples(_port(_storage(events)))({})) == []


def test_without_a_tenant_reads_only_tenant_less_records_with_a_tenant_only_that_tenants() -> None:
    events = [
        *reviewed("a-none", "sales.none", "2026-07-01T00:00:00.000Z"),
        *reviewed("a-acme", "sales.acme", "2026-07-02T00:00:00.000Z", tenant="acme"),
        *reviewed("a-globex", "sales.globex", "2026-07-03T00:00:00.000Z", tenant="globex"),
    ]
    provider = schema_edit_examples(_port(_storage(events)), limit=10)

    def types(input_: dict[str, Any]) -> list[str]:
        return types_of(run(provider(input_)))

    assert types({}) == ["sales.none"]
    assert types({"tenant": "acme"}) == ["sales.acme"]
    assert types({"tenant": "globex"}) == ["sales.globex"]
    # The input decides per call, so one provider serves every tenant without mixing them.
    assert types({}) == ["sales.none"]


def test_treats_an_empty_string_tenant_on_a_record_or_on_the_input_as_no_tenant() -> None:
    events = [
        *reviewed("a-none", "sales.none", "2026-07-01T00:00:00.000Z"),
        *reviewed("a-empty", "sales.empty", "2026-07-02T00:00:00.000Z", tenant=""),
        *reviewed("a-acme", "sales.acme", "2026-07-03T00:00:00.000Z", tenant="acme"),
    ]
    provider = schema_edit_examples(_port(_storage(events)), limit=10)
    assert types_of(run(provider({"tenant": ""}))) == ["sales.empty", "sales.none"]


def test_narrows_by_tenant_in_every_storage_query_one_window_read_then_a_lookup_per_case() -> None:
    events = [
        *reviewed("a-acme", "sales.acme", "2026-07-02T00:00:00.000Z", tenant="acme"),
        *reviewed("a-acme2", "sales.acme2", "2026-07-03T00:00:00.000Z", tenant="acme"),
        *reviewed("a-globex", "sales.globex", "2026-07-04T00:00:00.000Z", tenant="globex"),
    ]
    storage = _storage(events)
    examples = run(schema_edit_examples(_port(storage), limit=5)({"tenant": "acme"}))
    assert types_of(examples) == ["sales.acme2", "sales.acme"]
    assert examples[0] == {
        "final": draft("sales.acme2"),
        "suggestion": draft("sales.acme2Machine"),
        "htmlExcerpt": "<div>a-acme2</div>",
    }
    # One window read of the edits, then three lookups (proposed, suggested, generated) per case.
    assert len(storage.queries) == 1 + 2 * 3
    assert storage.queries[0].type == ["component.schemaEdited"]
    assert storage.queries[0].limit == 200
    assert storage.queries[0].tenant == "acme"
    assert storage.queries[0].artifactId is None
    for q in storage.queries:
        assert q.tenant == "acme"
    for q in storage.queries[1:]:
        assert q.limit == 1
        assert q.artifactId in ("a-acme", "a-acme2")


def test_reads_the_other_event_types_only_for_the_artifacts_that_become_examples() -> None:
    events = [
        e
        for i in range(12)
        for e in reviewed(f"a{i}", f"sales.n{i}", f"2026-07-{i + 1:02d}T00:00:00.000Z")
    ]
    storage = _storage(events)
    examples = run(schema_edit_examples(_port(storage), limit=3)({}))
    assert types_of(examples) == ["sales.n11", "sales.n10", "sales.n9"]
    # 1 window read + (proposed, suggested, generated) for exactly the 3 chosen artifacts: 12 cases cost no more.
    assert len(storage.queries) == 1 + 3 * 3
    lookups = storage.queries[1:]
    assert all(q.artifactId is not None for q in lookups)
    assert {q.artifactId for q in lookups} == {"a11", "a10", "a9"}
    # The only unbounded-looking read is the edits window; the HTML is looked up per artifact.
    assert [q.type for q in storage.queries if q.limit == 200] == [["component.schemaEdited"]]


def test_returns_early_after_the_single_edits_read_when_no_edit_changed_a_suggestion() -> None:
    events = [
        *reviewed("a1", "sales.one", "2026-07-01T00:00:00.000Z", changed=[]),
        *reviewed("a2", "sales.two", "2026-07-02T00:00:00.000Z", changed=[]),
    ]
    storage = _storage(events)
    assert run(schema_edit_examples(_port(storage))({})) == []
    assert len(storage.queries) == 1
    assert storage.queries[0].type == ["component.schemaEdited"]

    empty = _storage([])
    assert run(schema_edit_examples(_port(empty))({"tenant": "acme"})) == []
    assert len(empty.queries) == 1


def test_skips_a_case_whose_proposal_is_missing_at_the_cost_of_one_lookup() -> None:
    no_final = [
        e
        for e in reviewed("a-nofinal", "sales.noFinal", "2026-07-05T00:00:00.000Z")
        if e.type != "component.schemaProposed"
    ]
    events = [
        *reviewed("a-good", "sales.good", "2026-07-03T00:00:00.000Z"),
        *no_final,  # newest edit, no proposal
    ]
    storage = _storage(events)
    examples = run(schema_edit_examples(_port(storage), limit=1)({}))
    assert types_of(examples) == ["sales.good"]
    # edits window + (proposed for a-nofinal) + (proposed, suggested, generated for a-good)
    assert len(storage.queries) == 1 + 1 + 3


def test_without_a_tenant_a_per_artifact_lookup_reads_a_small_window_and_keeps_tenant_less() -> (
    None
):
    # The same artifactId promoted by two tenants: the newest record of each type belongs to acme.
    events = [
        *reviewed("shared", "sales.noTenant", "2026-07-01T00:00:00.000Z"),
        *reviewed("shared", "sales.acme", "2026-07-02T00:00:00.000Z", tenant="acme"),
    ]
    storage = _storage(events)
    examples = run(schema_edit_examples(_port(storage))({}))
    assert types_of(examples) == ["sales.noTenant"]
    assert all((q.limit or 0) > 1 for q in storage.queries[1:])


def test_returns_nothing_when_the_extraction_was_already_aborted() -> None:
    events = reviewed("a1", "sales.one", "2026-07-01T00:00:00.000Z")

    class _Aborted:
        aborted = True

    assert run(schema_edit_examples(_port(_storage(events)))({}, signal=_Aborted())) == []


def test_does_not_borrow_another_tenants_proposal_for_the_same_artifact_id() -> None:
    events = [
        # acme edited artifact "shared" but its own proposal is missing; globex has one for the same artifactId.
        ev(
            "component.schemaEdited",
            {"artifactId": "shared", "changed": CHANGED, "unchanged": []},
            "2026-07-02T00:00:01.000Z",
            "acme",
        ),
        ev(
            "component.schemaProposed",
            {"artifactId": "shared", "draft": draft("sales.globexOnly")},
            "2026-07-02T00:00:00.000Z",
            "globex",
        ),
    ]
    assert run(schema_edit_examples(_port(_storage(events)))({"tenant": "acme"})) == []


def test_raises_when_the_storage_fails() -> None:
    storage = _storage([])
    storage.failing = True
    with pytest.raises(RuntimeError, match="down"):
        run(schema_edit_examples(_port(storage))({}))


# --- per-tenant memo ---


def _memo_events() -> list[LineageEventRecord]:
    return [
        *reviewed("a-acme", "sales.acme", "2026-07-02T00:00:00.000Z", tenant="acme"),
        *reviewed("a-globex", "sales.globex", "2026-07-03T00:00:00.000Z", tenant="globex"),
        *reviewed("a-none", "sales.none", "2026-07-04T00:00:00.000Z"),
    ]


def test_reuses_a_tenants_result_within_the_ttl_so_a_batch_reads_the_log_once() -> None:
    async def go() -> None:
        storage = _storage(_memo_events())
        provider = schema_edit_examples(_port(storage), now=lambda: 1_000)
        first = await provider({"tenant": "acme"})
        reads_after_first = len(storage.queries)
        assert reads_after_first > 0
        for _ in range(5):
            assert await provider({"tenant": "acme"}) == first
        assert len(storage.queries) == reads_after_first

    run(go())


def test_keys_the_memo_by_tenant() -> None:
    async def go() -> None:
        provider = schema_edit_examples(
            _port(_storage(_memo_events())), now=lambda: 1_000, limit=10
        )

        async def types(tenant: str | None = None) -> list[str]:
            return types_of(await provider({"tenant": tenant} if tenant is not None else {}))

        assert await types("acme") == ["sales.acme"]
        assert await types("globex") == ["sales.globex"]
        assert await types() == ["sales.none"]
        # An empty tenant is the same scope as none (and shares its entry).
        assert await types("") == ["sales.none"]
        assert await types("acme") == ["sales.acme"]

    run(go())


def test_reads_the_log_again_once_the_ttl_has_passed_and_picks_up_a_newer_correction() -> None:
    async def go() -> None:
        live = reviewed("a1", "sales.one", "2026-07-01T00:00:00.000Z")
        storage = _storage(live)
        now = 0.0
        provider = schema_edit_examples(
            _port(storage), now=lambda: now, cache_ttl_ms=5_000, limit=10
        )
        assert types_of(await provider({})) == ["sales.one"]
        after_first = len(storage.queries)

        live.extend(reviewed("a2", "sales.two", "2026-07-02T00:00:00.000Z"))
        now = 4_999  # still inside the TTL: the new correction is not visible yet
        assert types_of(await provider({})) == ["sales.one"]
        assert len(storage.queries) == after_first

        now = 5_000  # the TTL has elapsed
        assert types_of(await provider({})) == ["sales.two", "sales.one"]
        assert len(storage.queries) > after_first

    run(go())


def test_defaults_the_ttl_to_5_seconds() -> None:
    async def go() -> None:
        storage = _storage(_memo_events())
        now = 100.0
        provider = schema_edit_examples(_port(storage), now=lambda: now)
        await provider({"tenant": "acme"})
        after_first = len(storage.queries)
        now += 4_999
        await provider({"tenant": "acme"})
        assert len(storage.queries) == after_first
        now += 1
        await provider({"tenant": "acme"})
        assert len(storage.queries) > after_first

    run(go())


def test_cache_ttl_ms_0_turns_the_memo_off() -> None:
    async def go() -> None:
        storage = _storage(_memo_events())
        provider = schema_edit_examples(_port(storage), now=lambda: 1_000, cache_ttl_ms=0)
        await provider({"tenant": "acme"})
        after_first = len(storage.queries)
        await provider({"tenant": "acme"})
        assert len(storage.queries) == after_first * 2

    run(go())


def test_shares_one_computation_between_calls_that_arrive_while_it_is_running() -> None:
    async def go() -> None:
        storage = _storage(_memo_events())
        provider = schema_edit_examples(_port(storage), now=lambda: 1_000)
        a, b, c = await asyncio.gather(
            provider({"tenant": "acme"}),
            provider({"tenant": "acme"}),
            provider({"tenant": "acme"}),
        )
        assert b == a
        assert c == a
        single = _storage(_memo_events())
        await schema_edit_examples(_port(single), now=lambda: 1_000)({"tenant": "acme"})
        assert len(storage.queries) == len(single.queries)

    run(go())


def test_does_not_remember_a_failure_the_next_call_reads_again() -> None:
    async def go() -> None:
        storage = _storage(_memo_events())
        provider = schema_edit_examples(_port(storage), now=lambda: 1_000)
        storage.failing = True
        with pytest.raises(RuntimeError, match="down"):
            await provider({"tenant": "acme"})
        storage.failing = False
        assert types_of(await provider({"tenant": "acme"})) == ["sales.acme"]

    run(go())


def test_an_aborted_caller_gets_nothing_without_poisoning_the_shared_result() -> None:
    class _Aborted:
        aborted = True

    async def go() -> None:
        provider = schema_edit_examples(_port(_storage(_memo_events())), now=lambda: 1_000)
        assert await provider({"tenant": "acme"}, signal=_Aborted()) == []
        assert types_of(await provider({"tenant": "acme"})) == ["sales.acme"]

    run(go())


def test_hands_each_caller_its_own_list() -> None:
    async def go() -> None:
        provider = schema_edit_examples(_port(_storage(_memo_events())), now=lambda: 1_000)
        first = await provider({"tenant": "acme"})
        first.clear()
        assert len(await provider({"tenant": "acme"})) == 1

    run(go())
