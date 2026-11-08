"""Schema suggestion at nomination, `component.schemaEdited` on approve, `acknowledgedSuggestion`, the judge's
`context.draft`, and `suggest_concurrency` (pytest port of packages/lineage/test/promotion-suggest.test.ts).

Storage is a tmp_path FileStoragePort (the TS test's in-memory StoragePort double is replaced, per the lineage
test convention in `_helpers.py`); the snapshot is read back through `get_promotion_state`.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from kohaku.lineage import (
    ComponentDraft,
    JudgeContext,
    PromotionCandidate,
    PromotionErrorContext,
    PromotionPolicy,
    SuggestContext,
    create_lineage,
    create_promotions,
)
from kohaku.spec import (
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    Principal,
    PromotionState,
    SchemaSuggestion,
    SuggestedDraft,
)
from kohaku.storage import FileStoragePort

from ._helpers import make_record

DRAFT = ComponentDraft(
    componentType="sales.calendarHeatmap",
    version="1.0.0",
    intentName="sales.calendar_heatmap",
    description="Display sales as a monthly calendar heatmap",
)

SUGGESTION = SchemaSuggestion(
    draft=SuggestedDraft(
        componentType="sales.calendarHeatmap",
        version="1.0.0",
        intentName="sales.calendar_heatmap",
        description="Display sales as a monthly calendar heatmap",
    ),
    events=[],
    confidence=0.9,
    model="fake-model",
    extractorId="l2-schema-extraction",
    extractorVersion="0.1",
    suggestedAt="2026-07-01T00:10:00.000Z",
)
SUGGESTION_WIRE = SUGGESTION.to_wire()


async def _seed_usage(
    storage: FileStoragePort, artifact_id: str, uses: int, *, tenant: str | None = None
) -> None:
    await storage.append_lineage(
        LineageEventRecord(
            id=f"g-{artifact_id}",
            ts="2026-07-01T00:00:00.000Z",
            actor=LineageActor(kind="model"),
            type="component.generated",
            payload={
                "artifactId": artifact_id,
                "html": "<html><body>hm</body></html>",
                "request": "Sales as a calendar heatmap",
            },
            tenant=tenant,
        )
    )
    for i in range(uses):
        await storage.append_lineage(
            LineageEventRecord(
                id=f"u-{artifact_id}-{i}",
                ts=f"2026-07-01T00:0{i}:00.000Z",
                actor=LineageActor(kind="system"),
                type="component.used",
                payload={
                    "artifactId": artifact_id,
                    "surface": "chat",
                    "sessionId": f"s{i}",
                    "outcome": "ok",
                },
                tenant=tenant,
            )
        )


def _pipeline(
    storage: FileStoragePort, suggest: Any = None, **extra: Any
) -> tuple[Any, list[tuple[PromotionErrorContext, BaseException]]]:
    errors: list[tuple[PromotionErrorContext, BaseException]] = []
    promotions = create_promotions(
        lineage=create_lineage(storage=storage),
        storage=storage,
        policy=_policy(),
        suggest_schema=suggest,
        on_error=lambda ctx, error: errors.append((ctx, error)),
        **extra,
    )
    return promotions, errors


def _policy() -> PromotionPolicy:
    return PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False)


async def _types(storage: FileStoragePort) -> list[str]:
    return [e.type for e in await storage.list_lineage(LineageFilter(limit=1000))]


async def _events_of(storage: FileStoragePort, type_: str) -> list[LineageEventRecord]:
    return await storage.list_lineage(LineageFilter(type=[type_], limit=1000))


async def _state(storage: FileStoragePort, artifact_id: str) -> PromotionState:
    state = await storage.get_promotion_state(artifact_id, None)
    assert state is not None
    return state


# --- schema suggestion at nomination (advisory, fail-open) ---


def test_calls_suggest_schema_for_each_newly_nominated_candidate_persists_and_audits(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)
        calls: list[PromotionCandidate] = []

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            calls.append(candidate)
            return SUGGESTION

        promotions, errors = _pipeline(storage, suggest)

        listed = await promotions.evaluate_and_list()
        assert listed[0].status == "candidate"
        assert listed[0].suggestion == SUGGESTION_WIRE
        assert len(calls) == 1
        assert calls[0].artifactId == "a1"
        # Persisted on the snapshot, and reloaded by a read-only list
        assert (await _state(storage, "a1")).data["suggestion"] == SUGGESTION_WIRE
        assert (await promotions.list_candidates())[0].suggestion == SUGGESTION_WIRE
        # Audit: model actor, after component.nominated
        types = await _types(storage)
        assert types.index("component.schemaSuggested") > types.index("component.nominated")
        suggested = (await _events_of(storage, "component.schemaSuggested"))[0]
        assert suggested.actor == LineageActor(kind="model")
        assert suggested.payload == {"artifactId": "a1", "suggestion": SUGGESTION_WIRE}
        assert errors == []

    asyncio.run(run())


def test_does_not_call_suggest_schema_again_for_an_already_nominated_candidate(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)
        calls = 0

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            nonlocal calls
            calls += 1
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest)
        await promotions.evaluate_and_list()
        await promotions.evaluate_and_list()
        assert calls == 1

    asyncio.run(run())


def test_fails_open_a_throwing_suggest_schema_reports_promotion_suggest_schema(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)

        async def suggest(candidate: PromotionCandidate, context: SuggestContext) -> None:
            raise RuntimeError("llm down")

        promotions, errors = _pipeline(storage, suggest)
        listed = await promotions.evaluate_and_list()
        assert listed[0].status == "candidate"
        assert listed[0].suggestion is None
        assert "suggestion" not in (await _state(storage, "a1")).data
        assert "component.schemaSuggested" not in await _types(storage)
        assert len(errors) == 1
        assert errors[0][0] == PromotionErrorContext(
            endpoint="promotion.suggest.schema", artifactId="a1"
        )

    asyncio.run(run())


def test_runs_extractions_concurrently_one_throwing_candidate_does_not_affect_the_other(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)
        await _seed_usage(storage, "a2", 2)

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            if candidate.artifactId == "a1":
                raise RuntimeError("llm down")
            return SUGGESTION

        promotions, errors = _pipeline(storage, suggest)
        listed = await promotions.evaluate_and_list()
        assert len(listed) == 2
        assert all(c.status == "candidate" for c in listed)
        a1 = next(c for c in listed if c.artifactId == "a1")
        a2 = next(c for c in listed if c.artifactId == "a2")
        assert a1.suggestion is None
        assert a2.suggestion == SUGGESTION_WIRE
        assert len(errors) == 1
        assert errors[0][0] == PromotionErrorContext(
            endpoint="promotion.suggest.schema", artifactId="a1"
        )
        types = await _types(storage)
        assert types.count("component.nominated") == 2
        assert types.count("component.schemaSuggested") == 1

    asyncio.run(run())


def test_a_null_suggestion_is_no_suggestion(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)

        async def suggest(candidate: PromotionCandidate, context: SuggestContext) -> None:
            return None

        promotions, errors = _pipeline(storage, suggest)
        listed = await promotions.evaluate_and_list()
        assert listed[0].suggestion is None
        assert "component.schemaSuggested" not in await _types(storage)
        assert errors == []

    asyncio.run(run())


def test_without_the_hook_nothing_changes_the_persisted_key_set_is_the_pre_existing_one(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)
        promotions, _ = _pipeline(storage, None)
        await promotions.evaluate_and_list()
        assert list((await _state(storage, "a1")).data.keys()) == ["request"]

    asyncio.run(run())


def test_the_hook_receives_the_call_level_tenant_as_context(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2, tenant="acme")
        contexts: list[SuggestContext] = []

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            contexts.append(context)
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest)
        await promotions.evaluate_and_list(tenant="acme")
        assert contexts == [SuggestContext(tenant="acme")]

    asyncio.run(run())


# --- component.schemaEdited on approve ---


def test_records_the_field_diff_between_the_suggestion_and_the_submitted_draft(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest)
        await promotions.evaluate_and_list()
        reviewer = Principal(id="alice")
        published = await promotions.approve("a1", ComponentDraft(**_draft_kwargs()), reviewer)
        assert published.status == "published"
        edited = (await _events_of(storage, "component.schemaEdited"))[0]
        assert edited.actor == LineageActor(kind="user", id="alice")
        assert edited.payload == {
            "artifactId": "a1",
            "reviewer": "alice",
            "extractorId": "l2-schema-extraction",
            "extractorVersion": "0.1",
            "changed": [],
            "unchanged": [
                "componentType",
                "version",
                "intentName",
                "description",
                "paramsJsonSchema",
                "queryTemplate",
            ],
            # acknowledged_suggestion was not passed to approve() in this test, so it defaults to False
            # (recorded, not enforced -- the approval still published above).
            "acknowledged": False,
        }
        types = await _types(storage)
        # The edit record sits between the human approve (component.reviewed) and publish
        assert types.index("component.schemaEdited") > types.index("component.reviewed")
        assert types.index("component.schemaEdited") < types.index("component.published")

    asyncio.run(run())


def _draft_kwargs(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "componentType": DRAFT.componentType,
        "version": DRAFT.version,
        "intentName": DRAFT.intentName,
        "description": DRAFT.description,
    }
    base.update(overrides)
    return base


def test_records_the_edited_fields_with_old_and_new_values(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest)
        await promotions.evaluate_and_list()
        await promotions.approve(
            "a1",
            ComponentDraft(**_draft_kwargs(description="Monthly sales heatmap")),
            Principal(id="alice"),
        )
        edited = (await _events_of(storage, "component.schemaEdited"))[0]
        assert edited.payload["changed"] == [
            {
                "field": "description",
                "suggested": DRAFT.description,
                "final": "Monthly sales heatmap",
            }
        ]

    asyncio.run(run())


def test_does_not_block_approve_publish_when_a_persisted_suggestion_is_malformed(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            return SUGGESTION

        promotions, errors = _pipeline(storage, suggest)
        await promotions.evaluate_and_list()
        # Simulate a truncated write / hand-edited promotions.json: `data.suggestion` exists but lacks `draft`.
        state = await _state(storage, "a1")
        await storage.put_promotion_state(
            PromotionState(
                artifactId=state.artifactId,
                status=state.status,
                updatedAt=state.updatedAt,
                data={**state.data, "suggestion": {"extractorId": "x"}},
                tenant=state.tenant,
            )
        )
        published = await promotions.approve(
            "a1", ComponentDraft(**_draft_kwargs()), Principal(id="alice")
        )
        assert published.status == "published"
        assert "component.schemaEdited" not in await _types(storage)
        assert any(ctx.endpoint == "promotion.approve.audit" for ctx, _ in errors)

    asyncio.run(run())


def test_records_nothing_when_the_candidate_has_no_suggestion(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)
        promotions, _ = _pipeline(storage, None)
        await promotions.evaluate_and_list()
        await promotions.approve("a1", DRAFT, Principal(id="alice"))
        assert "component.schemaEdited" not in await _types(storage)

    asyncio.run(run())


# --- acknowledgedSuggestion on approve (#9: recorded, not enforced) ---


def test_records_acknowledged_true_when_the_reviewer_ticks_the_acknowledgement(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest)
        await promotions.evaluate_and_list()
        published = await promotions.approve(
            "a1",
            ComponentDraft(**_draft_kwargs()),
            Principal(id="alice"),
            acknowledged_suggestion=True,
        )
        assert published.status == "published"
        edited = (await _events_of(storage, "component.schemaEdited"))[0]
        assert edited.payload["acknowledged"] is True

    asyncio.run(run())


def test_does_not_block_approve_publish_when_acknowledged_suggestion_is_false(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest)
        await promotions.evaluate_and_list()
        published = await promotions.approve(
            "a1",
            ComponentDraft(**_draft_kwargs()),
            Principal(id="alice"),
            acknowledged_suggestion=False,
        )
        assert published.status == "published"
        edited = (await _events_of(storage, "component.schemaEdited"))[0]
        assert edited.payload["acknowledged"] is False

    asyncio.run(run())


# --- the judge receives the draft actually being registered (#1) ---


def test_passes_approves_draft_argument_as_context_draft_alongside_the_tenant(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        # Tenant-tagged seed, so evaluate_and_list / approve can be scoped to "acme" throughout.
        await storage.append_lineage(
            make_record(
                "component.generated",
                {"artifactId": "a1", "html": "<html></html>", "request": "r"},
                tenant="acme",
                actor=LineageActor(kind="model"),
            )
        )
        for i in range(2):
            await storage.append_lineage(
                make_record(
                    "component.used",
                    {"artifactId": "a1", "surface": "chat", "sessionId": f"s{i}", "outcome": "ok"},
                    tenant="acme",
                )
            )
        seen: list[JudgeContext] = []

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            seen.append(context)
            return {"pass": True, "score": 1}

        promotions = create_promotions(
            lineage=create_lineage(storage=storage),
            storage=storage,
            policy=_policy(),
            judge=judge,
        )
        await promotions.evaluate_and_list(tenant="acme")
        final_draft = ComponentDraft(**_draft_kwargs(description="Final reviewer draft"))
        await promotions.approve("a1", final_draft, Principal(id="alice"), tenant="acme")
        assert len(seen) == 1
        assert seen[0].draft == final_draft
        assert seen[0].tenant == "acme"

    asyncio.run(run())


def test_passes_context_draft_even_when_the_candidate_has_no_machine_suggestion(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_usage(storage, "a1", 2)
        seen: list[JudgeContext] = []

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            seen.append(context)
            return {"pass": True, "score": 1}

        promotions = create_promotions(
            lineage=create_lineage(storage=storage),
            storage=storage,
            policy=_policy(),
            judge=judge,
        )
        await promotions.evaluate_and_list()
        await promotions.approve("a1", DRAFT, Principal(id="alice"))
        assert seen[0].draft == DRAFT

    asyncio.run(run())


# --- suggest_concurrency (#15): bounds how many suggest_schema calls run at once ---


async def _flush() -> None:
    for _ in range(50):
        await asyncio.sleep(0)


def test_suggest_concurrency_1_runs_extractions_strictly_one_at_a_time(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        for artifact_id in ("a1", "a2", "a3"):
            await _seed_usage(storage, artifact_id, 2)
        active = 0
        max_active = 0
        gates = {k: asyncio.Event() for k in ("a1", "a2", "a3")}

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await gates[candidate.artifactId].wait()
            active -= 1
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest, suggest_concurrency=1)
        evaluated = asyncio.create_task(promotions.evaluate_and_list())
        await _flush()
        assert active == 1  # only one in flight at a time
        gates["a1"].set()
        await _flush()
        gates["a2"].set()
        await _flush()
        gates["a3"].set()

        listed = await evaluated
        assert all(c.suggestion is not None for c in listed)
        assert max_active == 1

    asyncio.run(run())


def test_defaults_to_default_suggest_concurrency_4_when_unset(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        ids = ["a1", "a2", "a3", "a4", "a5"]
        for artifact_id in ids:
            await _seed_usage(storage, artifact_id, 2)
        active = 0
        max_active = 0
        gates = {k: asyncio.Event() for k in ids}

        async def suggest(
            candidate: PromotionCandidate, context: SuggestContext
        ) -> SchemaSuggestion:
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await gates[candidate.artifactId].wait()
            active -= 1
            return SUGGESTION

        promotions, _ = _pipeline(storage, suggest)  # suggest_concurrency intentionally omitted
        evaluated = asyncio.create_task(promotions.evaluate_and_list())
        await _flush()
        assert active == 4  # 5 candidates, default cap of 4
        for artifact_id in ids:
            gates[artifact_id].set()
            await _flush()
        await evaluated
        assert max_active == 4

    asyncio.run(run())
