"""Tests for Lineage.action_invoked/action_denied/action_approval_requested/action_approved and
create_action_audit_recorder (port of packages/lineage/test/action-audit.test.ts).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from kohaku.lineage import create_action_audit_recorder, create_lineage
from kohaku.spec import ApprovalGrant, LineageActor, LineageFilter, Principal
from kohaku.storage import FileStoragePort

PRINCIPAL = Principal(id="u1", roles=["user"])


def test_action_invoked_records_the_full_payload_and_omits_correlation_id_when_unset(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.action_invoked(
            {"action": "annotate", "payloadHash": "sha256:aaa", "tier": "auto"},
            LineageActor(kind="user", id="u1"),
            "tenant-a",
        )

        events = await storage.list_lineage()
        event = events[0]
        assert event.type == "action.invoked"
        assert event.actor == LineageActor(kind="user", id="u1")
        assert event.tenant == "tenant-a"
        assert event.payload == {"action": "annotate", "payloadHash": "sha256:aaa", "tier": "auto"}

    asyncio.run(run())


def test_action_invoked_includes_correlation_id_when_given(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.action_invoked(
            {
                "action": "annotate",
                "payloadHash": "sha256:aaa",
                "tier": "confirm",
                "correlationId": "corr-1",
            }
        )

        events = await storage.list_lineage()
        assert events[0].payload["correlationId"] == "corr-1"

    asyncio.run(run())


def test_action_denied_records_the_reason(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.action_denied(
            {"action": "delete", "payloadHash": "sha256:bbb", "tier": "approve", "reason": "approval already used"}
        )

        events = await storage.list_lineage()
        event = events[0]
        assert event.type == "action.denied"
        assert event.payload == {
            "action": "delete",
            "payloadHash": "sha256:bbb",
            "tier": "approve",
            "reason": "approval already used",
        }

    asyncio.run(run())


def test_action_approval_requested_omits_payload_by_default_and_includes_it_when_given(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.action_approval_requested(
            {"action": "delete", "payloadHash": "sha256:ccc", "tier": "approve", "requestId": "req-1"}
        )
        events = await storage.list_lineage()
        assert events[0].payload == {
            "action": "delete",
            "payloadHash": "sha256:ccc",
            "tier": "approve",
            "requestId": "req-1",
        }

        await lineage.action_approval_requested(
            {
                "action": "delete",
                "payloadHash": "sha256:ccc",
                "tier": "approve",
                "requestId": "req-2",
                "payload": {"id": 1},
            }
        )
        events = await storage.list_lineage()
        assert events[1].payload["payload"] == {"id": 1}

    asyncio.run(run())


def test_action_approved_records_approver_id_and_requester_id(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.action_approved(
            {
                "action": "delete",
                "payloadHash": "sha256:ddd",
                "approverId": "approver-1",
                "requesterId": "requester-1",
            }
        )

        events = await storage.list_lineage()
        event = events[0]
        assert event.type == "action.approved"
        assert event.payload == {
            "action": "delete",
            "payloadHash": "sha256:ddd",
            "approverId": "approver-1",
            "requesterId": "requester-1",
        }

    asyncio.run(run())


def test_is_retrievable_via_list_lineage_filtered_by_type(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)
        await lineage.action_invoked({"action": "a", "payloadHash": "sha256:x", "tier": "auto"})
        await lineage.record("view.composed", {"specHash": "irrelevant"})

        events = await storage.list_lineage(LineageFilter(type=["action.invoked"]))
        assert len(events) == 1
        assert events[0].type == "action.invoked"

    asyncio.run(run())


def test_recorder_invoked_stamps_actor_as_user_with_principal_id(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)
        recorder = create_action_audit_recorder(lineage)

        await recorder.invoked(
            action="annotate", payload_hash="sha256:x", tier="auto", principal=PRINCIPAL, tenant="tenant-a"
        )

        events = await storage.list_lineage()
        event = events[0]
        assert event.type == "action.invoked"
        assert event.actor == LineageActor(kind="user", id="u1")
        assert event.tenant == "tenant-a"

    asyncio.run(run())


def test_recorder_denied_forwards_the_reason(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        recorder = create_action_audit_recorder(create_lineage(storage=storage))

        await recorder.denied(
            action="delete",
            payload_hash="sha256:x",
            tier="approve",
            reason="approval expired",
            principal=PRINCIPAL,
        )

        events = await storage.list_lineage()
        assert events[0].payload["reason"] == "approval expired"

    asyncio.run(run())


def test_recorder_approval_requested_omits_the_payload_by_default(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        recorder = create_action_audit_recorder(create_lineage(storage=storage))

        await recorder.approval_requested(
            action="annotate",
            payload_hash="sha256:x",
            tier="confirm",
            request_id="req-1",
            payload={"note": "secret note"},
            principal=PRINCIPAL,
        )

        events = await storage.list_lineage()
        assert "payload" not in events[0].payload

    asyncio.run(run())


def test_recorder_approval_requested_includes_the_payload_when_record_payload_true(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        recorder = create_action_audit_recorder(create_lineage(storage=storage), record_payload=True)

        await recorder.approval_requested(
            action="annotate",
            payload_hash="sha256:x",
            tier="confirm",
            request_id="req-1",
            payload={"note": "visible to the approver"},
            principal=PRINCIPAL,
        )

        events = await storage.list_lineage()
        assert events[0].payload["payload"] == {"note": "visible to the approver"}

    asyncio.run(run())


def test_recorder_approved_records_the_grants_approver_id_and_requester_id(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        recorder = create_action_audit_recorder(create_lineage(storage=storage))

        await recorder.approved(
            action="delete",
            payload_hash="sha256:x",
            grant=ApprovalGrant(
                action="delete",
                payloadHash="sha256:x",
                approverId="approver-1",
                requesterId="u1",
                exp=9999999999,
                jti="jti-1",
            ),
            principal=PRINCIPAL,
        )

        events = await storage.list_lineage()
        event = events[0]
        assert event.type == "action.approved"
        assert event.payload["approverId"] == "approver-1"
        assert event.payload["requesterId"] == "u1"

    asyncio.run(run())
