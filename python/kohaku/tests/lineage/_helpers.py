"""Shared builders and storage subclasses for the lineage tests (a helper module not collected by pytest).

The TS tests use an in-memory StoragePort double, but this port follows the repository convention and uses a
tmp_path FileStoragePort. TS-double-specific behaviors such as unsupported deleteFixation and counting
listLineage calls are reproduced via subclasses of FileStoragePort.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kohaku.spec import (
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    UISpec,
    sha256_hex,
)
from kohaku.storage import FileStoragePort

L2_HTML = "<html><body><script>window.kohaku.ready()</script></body></html>"


@dataclass(frozen=True)
class FakeTrace:
    """Minimal implementation of ComposeTraceLike (view_composed references only durationMs)."""

    durationMs: float = 10.0


def l2_spec(cache: str = "miss", *, model: str | None = "test-model") -> UISpec:
    """An L2 Spec containing one sandbox.html. The artifact sha256 is derived deterministically from L2_HTML."""
    provenance: dict[str, Any] = {"tier": "L2", "composedBy": "composer@0.1.0", "cache": cache}
    if model is not None:
        provenance["model"] = model
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": {
                "canonical": "sales.custom",
                "params": {"request": "as a heatmap"},
                "hash": "sha256:" + "1" * 64,
            },
            "dataVersion": "sales@seed-1",
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["sandbox1"]},
                {
                    "id": "sandbox1",
                    "type": "sandbox.html",
                    "props": {},
                    "artifact": {"inline": L2_HTML, "sha256": sha256_hex(L2_HTML)},
                    "data": {"$ref": "query://sales/trend?metric=revenue"},
                },
            ],
            "events": [],
            "provenance": provenance,
        }
    )


def l1_spec() -> UISpec:
    """An L1 Spec with no artifact (produces only view.composed)."""
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": {
                "canonical": "sales.custom",
                "params": {"request": "as a heatmap"},
                "hash": "sha256:" + "1" * 64,
            },
            "dataVersion": "sales@seed-1",
            "components": [{"id": "root", "type": "layout.stack", "props": {}}],
            "events": [],
            "provenance": {"tier": "L1", "composedBy": "composer@0.1.0", "cache": "miss"},
        }
    )


def negotiated_spec() -> UISpec:
    """A Spec carrying a downgrade trace (provenance.fallback) from capability negotiation (for the fallback recording test)."""
    return UISpec.model_validate(
        {
            "kohaku": "0.1",
            "intent": {
                "canonical": "sales.custom",
                "params": {"request": "as a heatmap"},
                "hash": "sha256:" + "a" * 64,
            },
            "dataVersion": "sales@seed-1",
            "components": [{"id": "root", "type": "layout.stack", "props": {}}],
            "events": [],
            "provenance": {
                "tier": "L2",
                "composedBy": "composer@0.1.0",
                "cache": "hit",
                "fallback": {
                    "from": "sandbox1:sandbox.html",
                    "reason": "capability negotiation",
                    "kind": "negotiation",
                },
            },
        }
    )


# A deterministic base time for seeding. Each make_record adds +1ms to generate strictly-monotonic & valid ISO.
# The old implementation that wrapped seconds by i%60 made the generation order and ts lexicographic order
# non-monotonic across multiples of 60, and after 1000 cumulative events it produced 4-digit milliseconds =
# malformed ISO (consumers depend on ts lexicographic order).
_SEED_EPOCH = datetime(2026, 7, 17, tzinfo=UTC)
_counter = itertools.count()


def reset_seed_counter() -> None:
    """Reset the seed counter to 0 (call explicitly when you want id / ts to be deterministic across tests)."""
    global _counter
    _counter = itertools.count()


def make_record(
    type_: str,
    payload: dict[str, Any],
    *,
    tenant: str | None = None,
    actor: LineageActor | None = None,
) -> LineageEventRecord:
    """Assemble a LineageEventRecord for seeding (id / ts are strictly monotonic and deterministic; ts is valid ISO)."""
    i = next(_counter)
    ts = (
        (_SEED_EPOCH + timedelta(milliseconds=i))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    return LineageEventRecord(
        id=f"ev-{i}",
        ts=ts,
        actor=actor if actor is not None else LineageActor(kind="system"),
        type=type_,
        payload=payload,
        tenant=tenant,
    )


async def seed(
    storage: FileStoragePort,
    type_: str,
    payload: dict[str, Any],
    *,
    tenant: str | None = None,
    actor: LineageActor | None = None,
) -> LineageEventRecord:
    record = make_record(type_, payload, tenant=tenant, actor=actor)
    await storage.append_lineage(record)
    return record


class CountingStorage(FileStoragePort):
    """Counts the number of list_lineage calls that queried component.generated (for dedup verification)."""

    def __init__(self, data_dir: str | Path) -> None:
        super().__init__(data_dir)
        self.generated_lookups = 0

    async def list_lineage(
        self, filter: LineageFilter | None = None
    ) -> list[LineageEventRecord]:
        if filter is not None and filter.type is not None and "component.generated" in filter.type:
            self.generated_lookups += 1
        return await super().list_lineage(filter)


class NoDeleteFixationStorage(FileStoragePort):
    """A StoragePort that does not support delete_fixation (for fail-fast verification; NotImplementedError per the ports.py contract)."""

    async def delete_fixation(self, intent_hash: str, tenant: str | None = None) -> None:
        raise NotImplementedError("This StoragePort does not support delete_fixation")
