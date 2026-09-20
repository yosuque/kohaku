"""Promotion pipeline tests (pytest port of the promotion cases in lineage.test.ts + promotion-audit / promotion-reconcile).

Storage is a tmp_path FileStoragePort (uses real tenant key separation and promotion-state persistence).
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from kohaku.lineage import (
    ComponentDraft,
    JudgeContext,
    Nominate,
    PromotionCandidate,
    PromotionErrorContext,
    PromotionNotPublishedError,
    PromotionNotRejectedError,
    PromotionPolicy,
    Publish,
    PublishContext,
    ReviewRequestChanges,
    TransitionError,
    Unpublish,
    UnpublishContext,
    create_lineage,
    create_promotions,
)
from kohaku.lineage.promotion.service import _index_latest_generated, _usage_index_key
from kohaku.spec import LineageActor, LineageEventRecord, LineageFilter, Principal, PromotionState
from kohaku.storage import FileStoragePort

from ._helpers import seed

REVIEWER = Principal(id="admin")
DRAFT = ComponentDraft(
    componentType="sales.customX",
    version="1.0.0",
    intentName="sales.customX",
    description="test draft",
)


async def _seed_generated(
    storage: FileStoragePort,
    artifact_id: str,
    *,
    tenant: str | None = None,
    html: str | None = None,
    request: str | None = "r",
    sha256: str | None = None,
    ref: str | None = None,
) -> None:
    payload: dict[str, Any] = {"artifactId": artifact_id}
    if request is not None:
        payload["request"] = request
    if html is not None:
        payload["html"] = html
    if sha256 is not None:
        payload["artifactSha256"] = sha256
    if ref is not None:
        payload["ref"] = ref
    await seed(
        storage, "component.generated", payload, tenant=tenant, actor=LineageActor(kind="model")
    )


async def _put_state(
    storage: FileStoragePort,
    artifact_id: str,
    status: str,
    *,
    tenant: str | None = None,
    draft: ComponentDraft | None = None,
) -> None:
    data: dict[str, Any] = {"draft": draft.to_wire()} if draft is not None else {}
    await storage.put_promotion_state(
        PromotionState(
            artifactId=artifact_id, status=status, updatedAt="t", data=data, tenant=tenant
        )
    )


def _types(records: list[LineageEventRecord]) -> list[str]:
    return [e.type for e in records]


# --- Promotion evaluation (evaluate / list) ---


def test_evaluate_and_list_idempotent_nominate(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False),
        )
        await _seed_generated(storage, "a1")
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s2"})

        first = await promotions.evaluate_and_list()
        assert len(first) == 1
        assert first[0].status == "candidate"

        await promotions.evaluate_and_list()
        await promotions.evaluate_and_list()

        nominated = [e for e in await storage.list_lineage() if e.type == "component.nominated"]
        assert len(nominated) == 1

    asyncio.run(run())


def test_candidate_exposes_preview_material(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False),
        )
        await _seed_generated(
            storage,
            "a1",
            sha256="c" * 64,
            html="<html>preview</html>",
            ref="query://sales/trend?metric=revenue",
        )
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s1"})

        listed = await promotions.list_candidates()
        assert len(listed) == 1
        assert listed[0].html == "<html>preview</html>"
        assert listed[0].sha256 == "c" * 64
        assert listed[0].ref == "query://sales/trend?metric=revenue"

    asyncio.run(run())


def test_telemetry_used_not_counted(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False),
        )
        await _seed_generated(storage, "a1")
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s2"})
        # Telemetry-sourced (source:"telemetry") is observed real render, so it is excluded from aggregation
        await seed(
            storage,
            "component.used",
            {"artifactId": "a1", "sessionId": "s3", "source": "telemetry"},
        )

        listed = await promotions.evaluate_and_list()
        assert len(listed) == 1
        assert listed[0].uses == 2
        assert listed[0].sessions == 2

    asyncio.run(run())


def test_list_readonly_evaluate_nominates(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False),
        )
        await _seed_generated(storage, "a1")
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s2"})

        listed = await promotions.list_candidates()
        assert len(listed) == 1
        assert listed[0].status == "in_use"
        assert not any(e.type == "component.nominated" for e in await storage.list_lineage())

        evaluated = await promotions.evaluate_and_list()
        assert evaluated[0].status == "candidate"
        nominated = [e for e in await storage.list_lineage() if e.type == "component.nominated"]
        assert len(nominated) == 1

    asyncio.run(run())


# --- Promotion approval (approve) ---


def test_approve_publishes_error_on_failed_judge_blocking(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            return {"pass": False, "score": 0.1}

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=True),
            judge=judge,
        )

        with pytest.raises(PromotionNotPublishedError) as exc:
            await promotions.approve("a1", DRAFT, REVIEWER)
        assert exc.value.code == "PROMOTION_NOT_PUBLISHED"
        assert exc.value.status == "judge_failed"
        assert not any(e.type == "component.published" for e in await storage.list_lineage())

    asyncio.run(run())


def test_reapprove_published_is_idempotent(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
        )

        first = await promotions.approve("a1", DRAFT, REVIEWER)
        assert first.status == "published"
        second = await promotions.approve("a1", DRAFT, REVIEWER)
        assert second.status == "published"
        published = [e for e in await storage.list_lineage() if e.type == "component.published"]
        assert len(published) == 1

    asyncio.run(run())


def test_judge_throw_blocking_fails_closed(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            raise RuntimeError("LLM down")

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=True),
            judge=judge,
        )

        with pytest.raises(PromotionNotPublishedError) as exc:
            await promotions.approve("a1", DRAFT, REVIEWER)
        assert exc.value.status == "judge_failed"
        events = await storage.list_lineage()
        assert not any(e.type == "component.published" for e in events)
        judged = next(e for e in events if e.type == "component.judged")
        verdict = judged.payload["verdict"]
        assert verdict["pass"] is False
        assert "judge could not run" in str(verdict["reason"])

    asyncio.run(run())


def test_judge_throw_advisory_reaches_published(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            raise RuntimeError("LLM down")

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            judge=judge,
        )

        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"
        published = [e for e in await storage.list_lineage() if e.type == "component.published"]
        assert len(published) == 1

    asyncio.run(run())


# --- Review workflow enhancements: send-back recovery path ---


def test_changes_requested_approve_reaches_published(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")
        await _put_state(storage, "a1", "changes_requested")
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
        )

        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"
        # On recovery it is returned to candidate, so nominate is recorded.
        nominated = [e for e in await storage.list_lineage() if e.type == "component.nominated"]
        assert len(nominated) == 1
        # LIN-PRM-001: a human review.approve precedes component.published.
        events = await storage.list_lineage()
        reviewed_idx = next(
            i
            for i, e in enumerate(events)
            if e.type == "component.reviewed" and e.payload.get("decision") == "approve"
        )
        published_idx = next(i for i, e in enumerate(events) if e.type == "component.published")
        assert published_idx > reviewed_idx

    asyncio.run(run())


def test_changes_requested_round_trip_via_act(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")
        await _put_state(storage, "a1", "in_review")
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
        )

        changed = await promotions.act(
            "a1", ReviewRequestChanges(reviewer=REVIEWER, comment="please fix"), REVIEWER
        )
        assert changed.status == "changes_requested"
        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"

    asyncio.run(run())


def test_list_by_status_returns_only_status(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        for aid, status in (("p1", "published"), ("c1", "candidate"), ("r1", "in_review")):
            await _seed_generated(storage, aid)
            await _put_state(storage, aid, status)
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        assert [c.artifactId for c in await promotions.list_by_status("published")] == ["p1"]
        assert [c.artifactId for c in await promotions.list_by_status("candidate")] == ["c1"]
        assert [c.artifactId for c in await promotions.list_by_status("in_review")] == ["r1"]
        assert await promotions.list_by_status("rejected") == []

    asyncio.run(run())


def test_list_by_status_in_use_from_event_scan(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "u1")  # state not saved (in_use)
        await _seed_generated(storage, "c1")
        await _put_state(storage, "c1", "candidate")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        assert [c.artifactId for c in await promotions.list_by_status("in_use")] == ["u1"]
        assert [c.artifactId for c in await promotions.list_by_status("candidate")] == ["c1"]

    asyncio.run(run())


def test_list_by_status_tenant_isolation(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", tenant="acme")
        await _put_state(storage, "a1", "published", tenant="acme")
        await _seed_generated(storage, "b1", tenant="globex")
        await _put_state(storage, "b1", "published", tenant="globex")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        acme = await promotions.list_by_status("published", tenant="acme")
        globex = await promotions.list_by_status("published", tenant="globex")
        assert [c.artifactId for c in acme] == ["a1"]
        assert [c.artifactId for c in globex] == ["b1"]
        both = await promotions.list_by_status("published")
        assert sorted(c.artifactId for c in both) == ["a1", "b1"]

    asyncio.run(run())


# --- Promotion rejection (reject) ---


def test_reject_in_use_to_rejected(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        result = await promotions.reject("a1", REVIEWER)
        assert result.status == "rejected"
        reviewed = [e for e in await storage.list_lineage() if e.type == "component.reviewed"]
        assert len(reviewed) == 1
        assert reviewed[0].payload["decision"] == "reject"

    asyncio.run(run())


def test_reject_from_mid_state_raises(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1")
        await _put_state(storage, "a1", "approved")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        with pytest.raises(PromotionNotRejectedError) as exc:
            await promotions.reject("a1", REVIEWER)
        assert exc.value.code == "PROMOTION_NOT_REJECTED"
        assert exc.value.status == "approved"
        assert not any(e.type == "component.reviewed" for e in await storage.list_lineage())

    asyncio.run(run())


def test_rereject_rejected_is_idempotent(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1")
        await _put_state(storage, "a1", "rejected")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        result = await promotions.reject("a1", REVIEWER)
        assert result.status == "rejected"

    asyncio.run(run())


# --- Promotion withdrawal (unpublish / withdraw) ---


def test_act_unpublish_fires_hook_and_records(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")
        await _put_state(storage, "a1", "published", draft=DRAFT)
        unpublished: list[tuple[str, ComponentDraft]] = []

        async def on_unpublish(ctx: UnpublishContext) -> None:
            unpublished.append((ctx.artifactId, ctx.draft))

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_unpublish=on_unpublish
        )

        result = await promotions.act("a1", Unpublish(reason="obsolete"), REVIEWER)
        assert result.status == "withdrawn"
        assert unpublished == [("a1", DRAFT)]
        withdrawn = [e for e in await storage.list_lineage() if e.type == "component.withdrawn"]
        assert len(withdrawn) == 1
        assert withdrawn[0].payload["from"] == "published"
        assert withdrawn[0].payload["by"] == "admin"
        assert withdrawn[0].payload["reason"] == "obsolete"
        assert withdrawn[0].actor == LineageActor(kind="user", id="admin")
        got = await promotions.get("a1")
        assert got is not None and got.status == "withdrawn"

    asyncio.run(run())


def test_withdraw_selects_unpublish_or_withdraw(tmp_path: Path) -> None:
    async def run() -> None:
        # published -> unpublish (fires onUnpublish, from:published)
        pub_storage = FileStoragePort(tmp_path / "pub")
        await _seed_generated(pub_storage, "p1", html="<html></html>")
        await _put_state(pub_storage, "p1", "published", draft=DRAFT)
        unpublish_called = {"v": False}

        async def on_unpublish_pub(ctx: UnpublishContext) -> None:
            unpublish_called["v"] = True

        pub = create_promotions(
            lineage=create_lineage(pub_storage), storage=pub_storage, on_unpublish=on_unpublish_pub
        )
        pub_result = await pub.withdraw("p1", REVIEWER)
        assert pub_result.status == "withdrawn"
        assert unpublish_called["v"] is True
        pub_withdrawn = next(
            e for e in await pub_storage.list_lineage() if e.type == "component.withdrawn"
        )
        assert pub_withdrawn.payload["from"] == "published"

        # candidate -> withdraw (onUnpublish is not called and no from is attached)
        cand_storage = FileStoragePort(tmp_path / "cand")
        await _seed_generated(cand_storage, "c1", html="<html></html>")
        await _put_state(cand_storage, "c1", "candidate")
        cand_called = {"v": False}

        async def on_unpublish_cand(ctx: UnpublishContext) -> None:
            cand_called["v"] = True

        cand = create_promotions(
            lineage=create_lineage(cand_storage),
            storage=cand_storage,
            on_unpublish=on_unpublish_cand,
        )
        cand_result = await cand.withdraw("c1", REVIEWER)
        assert cand_result.status == "withdrawn"
        assert cand_called["v"] is False
        cand_withdrawn = next(
            e for e in await cand_storage.list_lineage() if e.type == "component.withdrawn"
        )
        assert "from" not in cand_withdrawn.payload

    asyncio.run(run())


def test_withdraw_terminal_propagates_transition_error(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "r1", html="<html></html>")
        await _put_state(storage, "r1", "rejected")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)
        with pytest.raises(TransitionError):
            await promotions.withdraw("r1", REVIEWER)

    asyncio.run(run())


# --- Rubric-version stamping + human-override audit ---


def _audit_override(history: list[LineageEventRecord]) -> dict[str, Any]:
    judged = next((e for e in history if e.type == "component.judged"), None)
    reviewed = next((e for e in history if e.type == "component.reviewed"), None)
    verdict = judged.payload.get("verdict") if judged is not None else None
    decision = reviewed.payload.get("decision") if reviewed is not None else None
    judged_pass = verdict.get("pass") if isinstance(verdict, dict) else None
    human_overrode = bool(
        verdict is not None
        and decision is not None
        and (
            (judged_pass is False and decision == "approve")
            or (judged_pass is True and decision == "reject")
        )
    )
    return {
        "judgedPass": judged_pass,
        "rubricId": verdict.get("rubricId") if isinstance(verdict, dict) else None,
        "rubricVersion": verdict.get("rubricVersion") if isinstance(verdict, dict) else None,
        "decision": decision,
        "humanOverrodeJudge": human_overrode,
    }


def test_judged_verdict_stamps_rubric(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            return {"pass": True, "score": 0.82, "rubricId": "l2-promotion", "rubricVersion": "0.1"}

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            judge=judge,
        )

        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"
        judged = next(e for e in await storage.list_lineage() if e.type == "component.judged")
        verdict = judged.payload["verdict"]
        assert verdict["rubricId"] == "l2-promotion"
        assert verdict["rubricVersion"] == "0.1"
        assert verdict["pass"] is True

    asyncio.run(run())


def test_human_override_detected(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            return {
                "pass": False,
                "score": 0.3,
                "reason": "low generality",
                "rubricId": "l2-promotion",
                "rubricVersion": "0.1",
            }

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            judge=judge,
        )

        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"
        history = await create_lineage(storage).history("a1")
        audit = _audit_override(history)
        assert audit["judgedPass"] is False
        assert audit["rubricId"] == "l2-promotion"
        assert audit["decision"] == "approve"
        assert audit["humanOverrodeJudge"] is True

    asyncio.run(run())


def test_concordant_not_override(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            return {"pass": True, "score": 0.9, "rubricId": "l2-promotion", "rubricVersion": "0.1"}

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            judge=judge,
        )
        await promotions.approve("a1", DRAFT, REVIEWER)
        audit = _audit_override(await create_lineage(storage).history("a1"))
        assert audit["judgedPass"] is True
        assert audit["decision"] == "approve"
        assert audit["humanOverrodeJudge"] is False

    asyncio.run(run())


# --- publish atomicity via startup reconcile ---


async def _seed_schema_proposed(
    storage: FileStoragePort, artifact_id: str, *, tenant: str | None = None
) -> None:
    await seed(
        storage,
        "component.generated",
        {"artifactId": artifact_id, "html": "<html>x</html>", "request": "r"},
        tenant=tenant,
        actor=LineageActor(kind="model"),
    )
    await seed(
        storage,
        "component.used",
        {"artifactId": artifact_id, "sessionId": "s1"},
        tenant=tenant,
        actor=LineageActor(kind="model"),
    )
    await _put_state(storage, artifact_id, "schema_proposed", tenant=tenant, draft=DRAFT)


def test_reconcile_converges_after_on_publish_failure(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-1")
        applied: list[tuple[str, str | None]] = []
        flags = {"fail": True}

        async def on_publish(ctx: PublishContext) -> None:
            if flags["fail"]:
                raise RuntimeError("projection application failed (test)")
            applied.append((ctx.artifactId, ctx.tenant))

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=on_publish
        )

        with pytest.raises(RuntimeError, match="projection application"):
            await promotions.act("art-1", Publish(version="1.0.0"), REVIEWER)

        # persist (step 2) is before on_publish, so the snapshot authority = published remains.
        state = await storage.get_promotion_state("art-1")
        assert state is not None and state.status == "published"
        assert any(e.type == "component.published" for e in await storage.list_lineage())
        assert applied == []

        # Startup reconcile: once on_publish recovers, the projection converges from the snapshot.
        flags["fail"] = False
        await promotions.reconcile()
        assert applied == [("art-1", None)]

    asyncio.run(run())


def test_validate_publish_gate_blocks_transition(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-2")
        applied: list[str] = []

        async def validate_publish(ctx: Any) -> None:
            raise RuntimeError("name collision (test)")

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            validate_publish=validate_publish,
            on_publish=on_publish,
        )

        with pytest.raises(RuntimeError, match="name collision"):
            await promotions.act("art-2", Publish(version="1.0.0"), REVIEWER)

        state = await storage.get_promotion_state("art-2")
        assert state is not None and state.status == "schema_proposed"
        assert not any(e.type == "component.published" for e in await storage.list_lineage())
        assert applied == []

    asyncio.run(run())


def test_reconcile_reapplies_per_tenant(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-shared", tenant="tenant-a")
        await _seed_schema_proposed(storage, "art-shared", tenant="tenant-b")
        applied: list[tuple[str, str | None]] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append((ctx.artifactId, ctx.tenant))

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=on_publish
        )

        await promotions.act("art-shared", Publish(version="1.0.0"), REVIEWER, "tenant-a")
        await promotions.act("art-shared", Publish(version="1.0.0"), REVIEWER, "tenant-b")
        applied.clear()

        await promotions.reconcile()
        assert ("art-shared", "tenant-a") in applied
        assert ("art-shared", "tenant-b") in applied
        assert len(applied) == 2

    asyncio.run(run())


# --- publish audit is fail-open ---


class _FailingAppendStorage(FileStoragePort):
    """A FileStoragePort that raises on append_lineage for event types listed in fail_for (test hook for the
    fail-open audit path). Mutable so a test can flip a type in and out between calls to reproduce "fails
    once, recovers on reconcile"."""

    def __init__(self, data_dir: Path) -> None:
        super().__init__(data_dir)
        self.fail_for: set[str] = set()

    async def append_lineage(self, event: LineageEventRecord) -> None:
        if event.type in self.fail_for:
            raise RuntimeError(f"append_lineage failed for {event.type} (test)")
        await super().append_lineage(event)


def test_publish_audit_failure_does_not_block_projection(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _FailingAppendStorage(tmp_path)
        await _seed_schema_proposed(storage, "art-4")
        storage.fail_for.add("component.published")

        applied: list[str] = []
        errors: list[tuple[str, str]] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=on_publish, on_error=on_error
        )

        # The audit record raise must not block the transition or the projection.
        result = await promotions.act("art-4", Publish(version="1.0.0"), REVIEWER)
        assert result.status == "published"
        assert applied == ["art-4"]
        assert not any(e.type == "component.published" for e in await storage.list_lineage())
        assert errors == [("promotion.publish.audit", "art-4")]

        # Startup reconcile backfills the missing audit event once recording is healthy again.
        storage.fail_for.discard("component.published")
        await promotions.reconcile()
        published = [e for e in await storage.list_lineage() if e.type == "component.published"]
        assert len(published) == 1
        assert published[0].payload.get("reconciled") is True
        # on_publish is re-applied by reconcile too (a separate, already-idempotent concern from #8).
        assert applied == ["art-4", "art-4"]

        # A second reconcile finds the backfilled event and does not duplicate it.
        await promotions.reconcile()
        assert len([e for e in await storage.list_lineage() if e.type == "component.published"]) == 1

    asyncio.run(run())


def test_reconcile_backfills_published_event(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _FailingAppendStorage(tmp_path)
        await _seed_schema_proposed(storage, "art-5")
        storage.fail_for.add("component.published")

        setup = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=lambda ctx: _noop()
        )
        await setup.act("art-5", Publish(version="1.0.0"), REVIEWER)
        assert not any(e.type == "component.published" for e in await storage.list_lineage())

        applied: list[str] = []
        errors: list[tuple[str, str]] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=on_publish, on_error=on_error
        )

        # The audit backfill still fails during this reconcile (fail_for is still set), but on_publish must run anyway.
        await promotions.reconcile()
        assert applied == ["art-5"]
        assert errors == [("promotion.reconcile.audit", "art-5")]
        assert not any(e.type == "component.published" for e in await storage.list_lineage())

    asyncio.run(run())


# --- unpublish atomicity (snapshot-first) ---


def test_unpublish_persists_before_projection_removal(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-3")
        setup = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=lambda ctx: _noop()
        )
        await setup.act("art-3", Publish(version="1.0.0"), REVIEWER)

        flags = {"fail": True}
        removed: list[str] = []

        async def on_unpublish(ctx: UnpublishContext) -> None:
            if flags["fail"]:
                raise RuntimeError("projection removal failed (test)")
            removed.append(ctx.artifactId)

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_unpublish=on_unpublish
        )

        with pytest.raises(RuntimeError, match="projection removal"):
            await promotions.act("art-3", Unpublish(), REVIEWER)

        # persist (step 1) is before on_unpublish (step 3), so the snapshot already transitioned to withdrawn.
        state = await storage.get_promotion_state("art-3")
        assert state is not None and state.status == "withdrawn"
        assert any(e.type == "component.withdrawn" for e in await storage.list_lineage())
        assert removed == []

        # Startup reconcile: once on_unpublish recovers, the projection removal converges from the snapshot.
        flags["fail"] = False
        await promotions.reconcile()
        assert removed == ["art-3"]

    asyncio.run(run())


def test_reconcile_removes_withdrawn_projection(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-published")
        await _seed_schema_proposed(storage, "art-withdrawn-a", tenant="tenant-a")
        await _seed_schema_proposed(storage, "art-withdrawn-b", tenant="tenant-b")

        setup = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            on_publish=lambda ctx: _noop(),
            on_unpublish=lambda ctx: _noop(),
        )
        await setup.act("art-published", Publish(version="1.0.0"), REVIEWER)
        await setup.act("art-withdrawn-a", Publish(version="1.0.0"), REVIEWER, "tenant-a")
        await setup.act("art-withdrawn-b", Publish(version="1.0.0"), REVIEWER, "tenant-b")
        await setup.act("art-withdrawn-a", Unpublish(), REVIEWER, "tenant-a")
        await setup.act("art-withdrawn-b", Unpublish(), REVIEWER, "tenant-b")

        removed: list[tuple[str, str | None]] = []
        applied: list[str] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        async def on_unpublish(ctx: UnpublishContext) -> None:
            removed.append((ctx.artifactId, ctx.tenant))

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            on_publish=on_publish,
            on_unpublish=on_unpublish,
        )

        await promotions.reconcile()

        assert ("art-withdrawn-a", "tenant-a") in removed
        assert ("art-withdrawn-b", "tenant-b") in removed
        assert len(removed) == 2
        # The published snapshot is re-applied to on_publish, never to on_unpublish.
        assert applied == ["art-published"]

    asyncio.run(run())


async def _noop() -> None:
    return None


# --- Tenant scope ---


def test_evaluate_and_list_tenant_scoped(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False),
        )
        await _seed_generated(storage, "a1", tenant="acme")
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s1"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "a1", "sessionId": "s2"}, tenant="acme")
        await _seed_generated(storage, "b1", tenant="globex")
        await seed(
            storage, "component.used", {"artifactId": "b1", "sessionId": "s3"}, tenant="globex"
        )
        await seed(
            storage, "component.used", {"artifactId": "b1", "sessionId": "s4"}, tenant="globex"
        )

        acme = await promotions.evaluate_and_list(tenant="acme")
        assert [c.artifactId for c in acme] == ["a1"]
        assert acme[0].uses == 2
        nominated = [e for e in await storage.list_lineage() if e.type == "component.nominated"]
        assert len(nominated) == 1
        assert nominated[0].tenant == "acme"

        all_candidates = await promotions.list_candidates()
        assert sorted(c.artifactId for c in all_candidates) == ["a1", "b1"]

    asyncio.run(run())


def test_get_tenant_scoped(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)
        await _seed_generated(storage, "a1", tenant="acme")

        assert await promotions.get("a1", "acme") is not None
        assert await promotions.get("a1", "globex") is None
        assert await promotions.get("a1") is not None

    asyncio.run(run())


def test_act_tenant_isolation(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False),
        )
        await _seed_generated(storage, "a1", tenant="acme")
        actor = Principal(id="admin")

        with pytest.raises(ValueError, match="unknown artifact"):
            await promotions.act("a1", Nominate(by=actor), actor, "globex")

        acted = await promotions.act("a1", Nominate(by=actor), actor, "acme")
        assert acted.status == "candidate"
        nominated = [e for e in await storage.list_lineage() if e.type == "component.nominated"]
        assert len(nominated) == 1
        assert nominated[0].tenant == "acme"

    asyncio.run(run())


def test_same_artifact_tenant_state_separation(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", tenant="acme", html="<html></html>")
        await _seed_generated(storage, "a1", tenant="globex", html="<html></html>")
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
        )

        acme_approved = await promotions.approve("a1", DRAFT, REVIEWER, "acme")
        assert acme_approved.status == "published"
        globex_state = await promotions.get("a1", "globex")
        assert globex_state is not None and globex_state.status == "in_use"

        globex_rejected = await promotions.reject("a1", REVIEWER, "globex")
        assert globex_rejected.status == "rejected"
        acme_state = await promotions.get("a1", "acme")
        assert acme_state is not None and acme_state.status == "published"

        assert [s.status for s in await storage.list_promotion_states("acme")] == ["published"]
        assert [s.status for s in await storage.list_promotion_states("globex")] == ["rejected"]

    asyncio.run(run())


# --- #10: tenant-unspecified scans must not mix tenants together ---


def test_scan_same_artifact_id_across_tenants_does_not_mix(tmp_path: Path) -> None:
    """artifactId derives from content sha256 and is globally unique, so the *same* artifactId can be
    promoted independently by multiple tenants. An all-tenant scan (tenant left unspecified) must not
    collapse those into a single candidate, nor sum their usage together (port of the TS
    promotion-tenant-mix.test.ts)."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "shared-x", tenant="acme")
        await _seed_generated(storage, "shared-x", tenant="globex")
        await seed(storage, "component.used", {"artifactId": "shared-x", "sessionId": "s1"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "shared-x", "sessionId": "s1"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "shared-x", "sessionId": "s1"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "shared-x", "sessionId": "s1"}, tenant="globex")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)
        await promotions.act("shared-x", Nominate(by=REVIEWER), REVIEWER, "acme")

        # Before #10, scanning across all tenants deduped by artifactId alone, collapsing both tenants' generated
        # events into a single candidate whose usage came from a plain-artifactId index (all tenants merged).
        candidates = [c for c in await promotions.list_candidates() if c.artifactId == "shared-x"]
        assert len(candidates) == 2
        assert sorted(c.uses for c in candidates) == [1, 3]

    asyncio.run(run())


def test_list_by_status_resolves_each_state_by_its_own_tenant(tmp_path: Path) -> None:
    """Before #10, list_by_status(tenant=None) called _load_candidate with the call-level (None) tenant instead
    of each state's own tenant, so a tenant-keyed promotion state was missed and the returned candidate's
    status silently reverted to "in_use"."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "shared-y", tenant="acme")
        await _seed_generated(storage, "shared-y", tenant="globex")
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)
        await promotions.act("shared-y", Nominate(by=REVIEWER), REVIEWER, "acme")

        candidates = await promotions.list_by_status("candidate")
        assert len(candidates) == 1
        assert candidates[0].status == "candidate"

    asyncio.run(run())


def test_evaluate_and_list_tenant_mismatch_skips_persist(tmp_path: Path) -> None:
    """A tenant-unspecified evaluate_and_list must not persist a tenant-tagged candidate under a tenant-neutral
    state; it is skipped (left in_use) and reported via on_error(promotion.nominate.tenant). A tenant-neutral
    candidate (single-tenant operation) is unaffected."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "acme-art", tenant="acme")
        await seed(storage, "component.used", {"artifactId": "acme-art", "sessionId": "s1"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "acme-art", "sessionId": "s1"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "acme-art", "sessionId": "s1"}, tenant="acme")
        await _seed_generated(storage, "neutral-art")
        await seed(storage, "component.used", {"artifactId": "neutral-art", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "neutral-art", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "neutral-art", "sessionId": "s1"})

        errors: list[tuple[str, str, str | None]] = []

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId, ctx.tenant))

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            on_error=on_error,
        )

        candidates = await promotions.evaluate_and_list()
        acme = next(c for c in candidates if c.artifactId == "acme-art")
        neutral = next(c for c in candidates if c.artifactId == "neutral-art")
        assert neutral.status == "candidate"
        assert acme.status == "in_use"
        assert await storage.get_promotion_state("acme-art", "acme") is None
        assert errors == [("promotion.nominate.tenant", "acme-art", "acme")]

    asyncio.run(run())


# --- nominate's idempotency guard is a (tenant, artifactId) composite key ---


def test_nominate_tenant_composite_key_does_not_suppress_cross_tenant_nominate(tmp_path: Path) -> None:
    """nominate's idempotency guard must be keyed by (tenant, artifactId), not artifactId alone (#10, mirroring
    candidate-store's own composite key): a past nominate recorded under tenant "acme" for artifactId
    "shared-z" must not suppress an independently eligible tenant-neutral candidate for that same
    (globally-unique) artifactId (port of TS promotion-nominate.test.ts)."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        # acme already nominated "shared-z" in the past (a component.nominated event tagged tenant="acme").
        await seed(storage, "component.nominated", {"artifactId": "shared-z", "by": "policy"}, tenant="acme")
        # A tenant-neutral candidate for the *same* globally-unique artifactId, independently eligible.
        await _seed_generated(storage, "shared-z")
        await seed(storage, "component.used", {"artifactId": "shared-z", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "shared-z", "sessionId": "s2"})
        await seed(storage, "component.used", {"artifactId": "shared-z", "sessionId": "s3"})

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
        )

        # Before the fix, nominated_ids was keyed by artifactId alone: an all-tenant scan (tenant
        # unspecified) would pull acme's component.nominated event into the same set as the tenant-neutral
        # candidate's own check, silently suppressing this eligible in_use candidate forever.
        candidates = await promotions.evaluate_and_list()
        neutral = next(c for c in candidates if c.artifactId == "shared-z")
        assert neutral.status == "candidate"
        state = await storage.get_promotion_state("shared-z", None)
        assert state is not None and state.status == "candidate"

    asyncio.run(run())


def test_nominate_tenant_composite_key_still_suppresses_same_tenant_reevaluation(tmp_path: Path) -> None:
    """A tenant's own past nominate must still suppress its own re-evaluation (no regression from the
    composite-key fix): the idempotency guard is event-log-driven precisely so GET-style repeated calls don't
    double-record, even when no promotion state was ever persisted for it in this test (a pre-existing
    nominate that predates this test's own storage snapshot)."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await seed(storage, "component.nominated", {"artifactId": "shared-w", "by": "policy"}, tenant="acme")
        await _seed_generated(storage, "shared-w", tenant="acme")
        await seed(storage, "component.used", {"artifactId": "shared-w", "sessionId": "s1"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "shared-w", "sessionId": "s2"}, tenant="acme")
        await seed(storage, "component.used", {"artifactId": "shared-w", "sessionId": "s3"}, tenant="acme")

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
        )

        await promotions.evaluate_and_list(tenant="acme")
        nominated = [
            e
            for e in await storage.list_lineage(LineageFilter(type=["component.nominated"], tenant="acme"))
            if e.payload.get("artifactId") == "shared-w"
        ]
        assert len(nominated) == 1

    asyncio.run(run())


# --- nominate's component.nominated audit is fail-open ---


def test_nominate_audit_failure_does_not_block_batch_and_reaches_on_error(tmp_path: Path) -> None:
    """The status transition (batch persist via _persist_many) already runs before the audit loop, so a
    storage hiccup recording one candidate's component.nominated event must not stop or undo the rest of the
    batch -- mirroring handle_publish's own fail-open audit record (port of TS promotion-nominate.test.ts)."""

    async def run() -> None:
        storage = _FailingAppendStorage(tmp_path)
        await _seed_generated(storage, "art-a")
        await seed(storage, "component.used", {"artifactId": "art-a", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "art-a", "sessionId": "s2"})
        await seed(storage, "component.used", {"artifactId": "art-a", "sessionId": "s3"})
        await _seed_generated(storage, "art-b")
        await seed(storage, "component.used", {"artifactId": "art-b", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "art-b", "sessionId": "s2"})
        await seed(storage, "component.used", {"artifactId": "art-b", "sessionId": "s3"})
        storage.fail_for.add("component.nominated")

        errors: list[tuple[str, str]] = []

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            on_error=on_error,
        )

        candidates = await promotions.evaluate_and_list()
        assert next(c for c in candidates if c.artifactId == "art-a").status == "candidate"
        assert next(c for c in candidates if c.artifactId == "art-b").status == "candidate"
        state_a = await storage.get_promotion_state("art-a")
        state_b = await storage.get_promotion_state("art-b")
        assert state_a is not None and state_a.status == "candidate"
        assert state_b is not None and state_b.status == "candidate"
        # Both failures are individually reported (the throw for art-a's own record must not stop art-b's).
        assert ("promotion.nominate.audit", "art-a") in errors
        assert ("promotion.nominate.audit", "art-b") in errors
        assert len(errors) == 2
        assert not any(e.type == "component.nominated" for e in await storage.list_lineage())

    asyncio.run(run())


def test_nominate_audit_recovers_once_recording_is_healthy(tmp_path: Path) -> None:
    """fail-open is not a permanent swallow: once appendLineage recovers, subsequent nominates are recorded normally."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "art-c")
        await seed(storage, "component.used", {"artifactId": "art-c", "sessionId": "s1"})
        await seed(storage, "component.used", {"artifactId": "art-c", "sessionId": "s2"})
        await seed(storage, "component.used", {"artifactId": "art-c", "sessionId": "s3"})

        errors: list[Any] = []
        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            on_error=lambda ctx, error: errors.append(ctx),
        )

        candidates = await promotions.evaluate_and_list()
        assert next(c for c in candidates if c.artifactId == "art-c").status == "candidate"
        assert any(e.type == "component.nominated" for e in await storage.list_lineage())
        assert errors == []

    asyncio.run(run())


# --- #11: idempotent re-projection on approve() / judge_failed recovery ---


def test_reapprove_published_reruns_on_publish(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")
        calls = {"n": 0}

        async def on_publish(ctx: PublishContext) -> None:
            calls["n"] += 1

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            on_publish=on_publish,
        )

        first = await promotions.approve("a1", DRAFT, REVIEWER)
        assert first.status == "published"
        assert calls["n"] == 1

        second = await promotions.approve("a1", DRAFT, REVIEWER)
        assert second.status == "published"
        assert calls["n"] == 2

    asyncio.run(run())


def test_reapprove_converges_a_failed_on_publish_without_waiting_for_reconcile(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")
        flags = {"fail": True}
        applied: list[str] = []

        async def on_publish(ctx: PublishContext) -> None:
            if flags["fail"]:
                raise RuntimeError("projection application failed (test)")
            applied.append(ctx.artifactId)

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=False),
            on_publish=on_publish,
        )

        with pytest.raises(RuntimeError, match="projection application"):
            await promotions.approve("a1", DRAFT, REVIEWER)
        state = await storage.get_promotion_state("a1")
        assert state is not None and state.status == "published"
        assert applied == []

        flags["fail"] = False
        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"
        assert applied == ["a1"]

    asyncio.run(run())


def test_approve_recovers_from_judge_failed(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_generated(storage, "a1", html="<html></html>")
        flags = {"pass": False}

        async def judge(candidate: PromotionCandidate, context: JudgeContext) -> dict[str, Any]:
            return {"pass": flags["pass"], "score": 1.0 if flags["pass"] else 0.0}

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            policy=PromotionPolicy(minUses=1, minDistinctSessions=1, judgeBlocking=True),
            judge=judge,
            on_publish=lambda ctx: _noop(),
        )

        with pytest.raises(PromotionNotPublishedError):
            await promotions.approve("a1", DRAFT, REVIEWER)
        state = await storage.get_promotion_state("a1")
        assert state is not None and state.status == "judge_failed"

        flags["pass"] = True
        result = await promotions.approve("a1", DRAFT, REVIEWER)
        assert result.status == "published"

    asyncio.run(run())


# --- #11: unpublish audit fail-open + reconcile summary/backfill ---


def test_unpublish_audit_failure_is_fail_open_and_reconcile_backfills(tmp_path: Path) -> None:
    async def run() -> None:
        storage = _FailingAppendStorage(tmp_path)
        await _seed_schema_proposed(storage, "art-9")
        setup = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=lambda ctx: _noop()
        )
        await setup.act("art-9", Publish(version="1.0.0"), REVIEWER)

        storage.fail_for.add("component.withdrawn")
        removed: list[str] = []
        errors: list[tuple[str, str]] = []

        async def on_unpublish(ctx: UnpublishContext) -> None:
            removed.append(ctx.artifactId)

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_unpublish=on_unpublish, on_error=on_error
        )

        # unpublish's own audit record raise must not block the projection removal.
        result = await promotions.act("art-9", Unpublish(), REVIEWER)
        assert result.status == "withdrawn"
        assert removed == ["art-9"]
        assert not any(
            e.type == "component.withdrawn" and e.payload.get("from") == "published"
            for e in await storage.list_lineage()
        )
        assert errors == [("promotion.unpublish.audit", "art-9")]

        storage.fail_for.discard("component.withdrawn")
        summary = await promotions.reconcile()
        withdrawn_events = [
            e
            for e in await storage.list_lineage()
            if e.type == "component.withdrawn" and e.payload.get("from") == "published"
        ]
        assert len(withdrawn_events) == 1
        assert withdrawn_events[0].payload.get("reconciled") is True
        assert summary.withdrawn == 1

        # A second reconcile does not duplicate the backfilled event.
        await promotions.reconcile()
        assert (
            len(
                [
                    e
                    for e in await storage.list_lineage()
                    if e.type == "component.withdrawn" and e.payload.get("from") == "published"
                ]
            )
            == 1
        )

    asyncio.run(run())


def test_reconcile_returns_summary_and_reports_projection_skip(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        # A published state with no matching component.generated event and no self-contained html copy —
        # reconcile has no source to rebuild the projection from.
        await storage.put_promotion_state(
            PromotionState(
                artifactId="art-orphan", status="published", updatedAt="t", data={"draft": DRAFT.to_wire()}
            )
        )

        applied: list[str] = []
        errors: list[tuple[str, str]] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=on_publish, on_error=on_error
        )

        summary = await promotions.reconcile()
        assert applied == []
        assert summary.published == 0
        assert summary.withdrawn == 0
        assert summary.skipped == 1
        assert errors == [("promotion.reconcile.projection", "art-orphan")]

    asyncio.run(run())


def test_reconcile_rebuilds_published_projection_from_snapshot_after_lineage_loss(tmp_path: Path) -> None:
    """#9: once published, the snapshot's own html/sha256/ref/componentType duplicate lets reconcile rebuild
    the projection even if lineage.jsonl (and hence component.generated) is lost or replaced."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-1")
        seed_promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=lambda ctx: _noop()
        )
        await seed_promotions.act("art-1", Publish(version="1.0.0"), REVIEWER)
        published_state = await storage.get_promotion_state("art-1")
        assert published_state is not None
        assert published_state.data.get("html") == "<html>x</html>"
        assert published_state.data.get("componentType") == DRAFT.componentType

        # Simulate a lost/replaced lineage.jsonl: truncate the log file directly, then re-open the storage port
        # (FileStoragePort caches lineage in memory at construction, so reusing the same `storage` object would
        # not observe the truncation) so it reloads from the now-empty file. The promotion-state snapshot
        # (promotions.json) is untouched.
        lineage_path = tmp_path / "lineage.jsonl"
        if lineage_path.exists():
            lineage_path.write_text("")
        storage = FileStoragePort(tmp_path)

        applied: list[PublishContext] = []
        errors: list[Any] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx)

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            on_publish=on_publish,
            on_error=lambda ctx, e: errors.append((ctx, e)),
        )

        summary = await promotions.reconcile()
        assert len(applied) == 1
        assert applied[0].artifactId == "art-1"
        assert applied[0].html == "<html>x</html>"
        assert summary.published == 1
        assert summary.skipped == 0
        assert errors == []

        candidate = await promotions.get("art-1")
        assert candidate is not None
        assert candidate.status == "published"
        assert candidate.html == "<html>x</html>"

    asyncio.run(run())


# --- reconcile scan/load race (mirrors TS's promotion-reconcile-race.test.ts) ---


class _RacingStorage(FileStoragePort):
    """A FileStoragePort whose get_promotion_state answers `override_status` for one artifact, while
    list_promotion_states (the scan reconcile uses to build its work list) keeps returning the real,
    unmodified state. Reproduces "a concurrent transition changed the status between the scan and the load"
    deterministically, without any real concurrency. Calls super() first (not a bypass) so the on-disk cache
    semantics of FileStoragePort are preserved; only the returned dataclass's status field is swapped."""

    def __init__(self, data_dir: Path, artifact_id: str, override_status: str) -> None:
        super().__init__(data_dir)
        self._racing_artifact_id = artifact_id
        self._override_status = override_status

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None:
        real = await super().get_promotion_state(artifact_id, tenant)
        if real is None or artifact_id != self._racing_artifact_id:
            return real
        return dataclasses.replace(real, status=self._override_status)


def test_reconcile_does_not_republish_a_candidate_that_became_withdrawn_after_the_scan(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-1")
        seed_promotions = create_promotions(
            lineage=create_lineage(storage), storage=storage, on_publish=lambda ctx: _noop()
        )
        await seed_promotions.act("art-1", Publish(version="1.0.0"), REVIEWER)
        state = await storage.get_promotion_state("art-1")
        assert state is not None and state.status == "published"
        published_events_before = [
            e for e in await storage.list_lineage() if e.type == "component.published"
        ]
        assert len(published_events_before) == 1

        # Simulate the race: list_promotion_states (the scan) still returns "published" (the real, unmodified
        # state), but get_promotion_state's own read (used by _load_candidate) now answers "withdrawn" -- as if
        # a tenant-scoped withdraw ran between the scan and this load.
        racing = _RacingStorage(tmp_path, "art-1", "withdrawn")
        applied: list[str] = []
        removed: list[str] = []
        errors: list[tuple[str, str]] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        async def on_unpublish(ctx: UnpublishContext) -> None:
            removed.append(ctx.artifactId)

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(racing),
            storage=racing,
            on_publish=on_publish,
            on_unpublish=on_unpublish,
            on_error=on_error,
        )

        summary = await promotions.reconcile()
        # Not republished (a stale scan entry): reconcile trusts the fresher load, not the scan's own snapshot.
        assert applied == []
        # Not (incorrectly) unpublished either: the withdrawn branch is driven by list_promotion_states' own
        # status ("published" here, unmodified), so this artifact never enters that branch at all.
        assert removed == []
        assert summary.published == 0
        assert summary.withdrawn == 0
        assert summary.skipped == 0
        # A stale scan entry is not a failure: no on_error, and no new component.published audit backfill
        # (the count stays at the single event the original publish already recorded).
        assert errors == []
        published_events_after = [
            e for e in await storage.list_lineage() if e.type == "component.published"
        ]
        assert len(published_events_after) == 1

    asyncio.run(run())


def test_reconcile_does_not_unpublish_a_candidate_that_became_published_after_the_scan(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _seed_schema_proposed(storage, "art-2")
        seed_promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            on_publish=lambda ctx: _noop(),
            on_unpublish=lambda ctx: _noop(),
        )
        await seed_promotions.act("art-2", Publish(version="1.0.0"), REVIEWER)
        await seed_promotions.act("art-2", Unpublish(), REVIEWER)
        state = await storage.get_promotion_state("art-2")
        assert state is not None and state.status == "withdrawn"
        withdrawn_events_before = [
            e
            for e in await storage.list_lineage()
            if e.type == "component.withdrawn" and e.payload.get("from") == "published"
        ]
        assert len(withdrawn_events_before) == 1

        # Simulate the reverse race: list_promotion_states still returns "withdrawn" (unmodified), but
        # get_promotion_state's own read now answers "published" -- as if a tenant-scoped re-approve/publish
        # ran between the scan and this load.
        racing = _RacingStorage(tmp_path, "art-2", "published")
        applied: list[str] = []
        removed: list[str] = []
        errors: list[tuple[str, str]] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        async def on_unpublish(ctx: UnpublishContext) -> None:
            removed.append(ctx.artifactId)

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(racing),
            storage=racing,
            on_publish=on_publish,
            on_unpublish=on_unpublish,
            on_error=on_error,
        )

        summary = await promotions.reconcile()
        assert removed == []
        assert applied == []
        assert summary.published == 0
        assert summary.withdrawn == 0
        assert summary.skipped == 0
        assert errors == []
        withdrawn_events_after = [
            e
            for e in await storage.list_lineage()
            if e.type == "component.withdrawn" and e.payload.get("from") == "published"
        ]
        assert len(withdrawn_events_after) == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    "status", ["schema_proposed", "approved", "rejected", "changes_requested", "judge_failed"]
)
def test_reconcile_ignores_non_projection_statuses(tmp_path: Path, status: str) -> None:
    """may_have_projection: reconcile skips a snapshot whose status is not published/withdrawn entirely, before
    ever loading it -- not calling on_publish/on_unpublish, not counting it as skipped, and not emitting any
    audit event for it."""

    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        await _put_state(storage, f"art-{status}", status, draft=DRAFT)

        applied: list[str] = []
        removed: list[str] = []
        errors: list[tuple[str, str]] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        async def on_unpublish(ctx: UnpublishContext) -> None:
            removed.append(ctx.artifactId)

        def on_error(ctx: PromotionErrorContext, error: BaseException) -> None:
            errors.append((ctx.endpoint, ctx.artifactId))

        promotions = create_promotions(
            lineage=create_lineage(storage),
            storage=storage,
            on_publish=on_publish,
            on_unpublish=on_unpublish,
            on_error=on_error,
        )

        summary = await promotions.reconcile()
        assert removed == []
        assert applied == []
        assert summary.published == 0
        assert summary.withdrawn == 0
        assert summary.skipped == 0
        assert errors == []
        events = await storage.list_lineage()
        assert not any(e.type in ("component.withdrawn", "component.published") for e in events)

    asyncio.run(run())


# --- N+1 avoidance in reconcile() and list_by_status() (perf, mirrors TS's promotion-n-plus-one.test.ts) ---


class _CountingListLineageStorage(FileStoragePort):
    """A FileStoragePort that counts list_lineage calls, to pin that reconcile()/list_by_status() build a
    fixed set of bulk indexes once instead of calling list_lineage once per candidate."""

    def __init__(self, data_dir: Path) -> None:
        super().__init__(data_dir)
        self.list_lineage_calls = 0

    async def list_lineage(self, filter: LineageFilter | None = None) -> list[LineageEventRecord]:
        self.list_lineage_calls += 1
        return await super().list_lineage(filter)


async def _seed_published_candidates(storage: FileStoragePort, count: int) -> None:
    """Seeds `count` independent published candidates, each self-contained (#9: html/sha256 duplicated onto
    the snapshot) with its own component.generated event, so every candidate can be fully resolved without any
    per-candidate fallback lookup."""
    for i in range(count):
        artifact_id = f"art-{i}"
        await seed(
            storage,
            "component.generated",
            {"artifactId": artifact_id, "html": f"<html>{i}</html>", "request": "r"},
            actor=LineageActor(kind="model"),
        )
        await storage.put_promotion_state(
            PromotionState(
                artifactId=artifact_id,
                status="published",
                updatedAt="t",
                data={
                    "draft": DRAFT.to_wire(),
                    "html": f"<html>{i}</html>",
                    "sha256": "a" * 64,
                    "componentType": DRAFT.componentType,
                },
            )
        )


@pytest.mark.parametrize("count", [3, 30])
def test_reconcile_list_lineage_calls_do_not_scale_with_candidate_count(tmp_path: Path, count: int) -> None:
    async def run() -> None:
        storage = _CountingListLineageStorage(tmp_path)
        await _seed_published_candidates(storage, count)
        applied: list[str] = []

        async def on_publish(ctx: PublishContext) -> None:
            applied.append(ctx.artifactId)

        promotions = create_promotions(lineage=create_lineage(storage), storage=storage, on_publish=on_publish)

        storage.list_lineage_calls = 0
        summary = await promotions.reconcile()
        assert len(applied) == count
        assert summary.published == count
        # Fixed set of bulk index fetches (usage, component.generated, component.published,
        # component.withdrawn) regardless of how many candidates were scanned -- not one list_lineage call per
        # candidate.
        assert storage.list_lineage_calls == 4

    asyncio.run(run())


@pytest.mark.parametrize("count", [3, 30])
def test_list_by_status_list_lineage_calls_do_not_scale_with_candidate_count(tmp_path: Path, count: int) -> None:
    async def run() -> None:
        storage = _CountingListLineageStorage(tmp_path)
        await _seed_published_candidates(storage, count)
        promotions = create_promotions(lineage=create_lineage(storage), storage=storage)

        storage.list_lineage_calls = 0
        candidates = await promotions.list_by_status("published")
        assert len(candidates) == count
        # Fixed set of bulk index fetches (usage, component.generated) regardless of candidate count.
        assert storage.list_lineage_calls == 2

    asyncio.run(run())


# --- _usage_index_key / _index_latest_generated (mirrors TS usage.test.ts) --------------------------------


def test_usage_index_key_is_collision_free_for_space_containing_values() -> None:
    # The JSON-array encoding is collision-free for any input, including a tenant/artifact_id pair that
    # contains the delimiter the previous encoding used (a Unit Separator, not a space -- see
    # _usage_index_key's docstring for what the previous encoding actually was).
    assert _usage_index_key("a b", "c") != _usage_index_key("a", "b c")


def test_usage_index_key_treats_none_tenant_and_empty_string_tenant_as_distinct() -> None:
    # R2: no existing caller relies on tenant=None and tenant="" producing the same key.
    assert _usage_index_key(None, "x") != _usage_index_key("", "x")


def test_usage_index_key_is_a_json_array_of_tenant_and_artifact_id() -> None:
    assert _usage_index_key("acme", "art-1") == json.dumps(["acme", "art-1"], separators=(",", ":"))
    assert _usage_index_key(None, "art-1") == json.dumps([None, "art-1"], separators=(",", ":"))


def _generated_event(ts: str, tenant: str | None, artifact_id: object) -> LineageEventRecord:
    return LineageEventRecord(
        id=f"g-{ts}",
        ts=ts,
        actor=LineageActor(kind="model"),
        type="component.generated",
        payload={"artifactId": artifact_id},
        tenant=tenant,
    )


def test_index_latest_generated_keeps_only_the_greatest_ts_event_per_key() -> None:
    older = _generated_event("2026-01-01T00:00:00.000Z", "acme", "art-1")
    newer = _generated_event("2026-01-02T00:00:00.000Z", "acme", "art-1")
    result = _index_latest_generated([older, newer])
    assert len(result) == 1
    assert result[_usage_index_key("acme", "art-1")] is newer


def test_index_latest_generated_keeps_entries_separate_across_distinct_keys() -> None:
    a = _generated_event("2026-01-01T00:00:00.000Z", "acme", "art-1")
    b = _generated_event("2026-01-01T00:00:00.000Z", "other", "art-1")
    c = _generated_event("2026-01-01T00:00:00.000Z", None, "art-2")
    result = _index_latest_generated([a, b, c])
    assert len(result) == 3
    assert result[_usage_index_key("acme", "art-1")] is a
    assert result[_usage_index_key("other", "art-1")] is b
    assert result[_usage_index_key(None, "art-2")] is c


def test_index_latest_generated_skips_events_whose_artifact_id_is_not_a_string() -> None:
    missing = dataclasses.replace(_generated_event("2026-01-01T00:00:00.000Z", "acme", None), payload={})
    wrong_type = _generated_event("2026-01-02T00:00:00.000Z", "acme", 42)
    valid = _generated_event("2026-01-03T00:00:00.000Z", "acme", "art-1")
    result = _index_latest_generated([missing, wrong_type, valid])
    assert len(result) == 1
    assert result[_usage_index_key("acme", "art-1")] is valid
