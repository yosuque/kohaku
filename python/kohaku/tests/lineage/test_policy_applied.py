"""Tests for Lineage.policy_applied (port of packages/lineage/test/policy-applied.test.ts)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from kohaku.lineage import create_lineage
from kohaku.spec import LineageActor, LineageFilter
from kohaku.storage import FileStoragePort


def test_records_a_policy_applied_event_with_the_full_payload(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.policy_applied(
            {
                "policyId": "sha256:new",
                "previousPolicyId": "sha256:old",
                "version": 1,
                "label": "v2",
                "changedPaths": ["defaults.compose.allowL2"],
                "tenants": ["tenant-a"],
            },
            LineageActor(kind="user", id="alice"),
        )

        events = await storage.list_lineage()
        assert len(events) == 1
        event = events[0]
        assert event.type == "policy.applied"
        assert event.actor == LineageActor(kind="user", id="alice")
        assert event.payload == {
            "policyId": "sha256:new",
            "previousPolicyId": "sha256:old",
            "version": 1,
            "label": "v2",
            "changedPaths": ["defaults.compose.allowL2"],
            "tenants": ["tenant-a"],
        }

    asyncio.run(run())


def test_omits_previous_policy_id_and_label_when_unset(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.policy_applied(
            {"policyId": "sha256:first", "version": 1, "changedPaths": ["defaults"], "tenants": []}
        )

        events = await storage.list_lineage()
        assert sorted(events[0].payload.keys()) == ["changedPaths", "policyId", "tenants", "version"]

    asyncio.run(run())


def test_stamps_the_tenant_onto_the_record_when_given(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.policy_applied(
            {"policyId": "sha256:x", "version": 1, "changedPaths": [], "tenants": []},
            None,
            "tenant-a",
        )

        events = await storage.list_lineage()
        assert events[0].tenant == "tenant-a"

    asyncio.run(run())


def test_defaults_to_a_system_actor_when_none_is_given(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)

        await lineage.policy_applied({"policyId": "sha256:x", "version": 1, "changedPaths": [], "tenants": []})

        events = await storage.list_lineage()
        assert events[0].actor == LineageActor(kind="system")

    asyncio.run(run())


def test_is_retrievable_via_list_lineage_filtered_by_type(tmp_path: Path) -> None:
    async def run() -> None:
        storage = FileStoragePort(tmp_path)
        lineage = create_lineage(storage=storage)
        await lineage.policy_applied({"policyId": "sha256:x", "version": 1, "changedPaths": [], "tenants": []})
        await lineage.record("view.composed", {"specHash": "irrelevant"})

        events = await storage.list_lineage(LineageFilter(type=["policy.applied"]))
        assert len(events) == 1
        assert events[0].type == "policy.applied"

    asyncio.run(run())
