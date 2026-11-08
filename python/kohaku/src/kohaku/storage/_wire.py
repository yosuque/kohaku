"""Wire (JSON-shaped dict) conversion of the StoragePort record types, shared by every Python StoragePort
adapter (the file port and the Redis / Postgres adapters), plus the compact JSON text form the shared-backend
adapters store.

These shapes are the TS `JSON.stringify(record)` shapes (absent optional fields are omitted, never `null`), which
is what lets a TS host and a Python host share one Redis / Postgres backend.
"""

from __future__ import annotations

import json
from typing import Any

from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    Principal,
    PromotionState,
    UISpec,
)


def dumps_compact(value: Any) -> str:
    """JSON text as `JSON.stringify` writes it: no whitespace between tokens and non-ASCII characters left
    unescaped. A Redis value / Postgres text column written here is byte-shaped like the one a TS host writes."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def lineage_to_wire(event: LineageEventRecord) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": event.id,
        "ts": event.ts,
        "actor": {
            "kind": event.actor.kind,
            **({"id": event.actor.id} if event.actor.id is not None else {}),
            **({"model": event.actor.model} if event.actor.model is not None else {}),
        },
        "type": event.type,
        "payload": event.payload,
    }
    if event.tenant is not None:
        out["tenant"] = event.tenant
    return out


def lineage_from_wire(data: dict[str, Any]) -> LineageEventRecord:
    actor = data.get("actor") or {}
    return LineageEventRecord(
        id=str(data.get("id", "")),
        ts=str(data.get("ts", "")),
        actor=LineageActor(
            kind=actor.get("kind", "system"), id=actor.get("id"), model=actor.get("model")
        ),
        type=str(data.get("type", "")),
        payload=data.get("payload") or {},
        tenant=data.get("tenant"),
    )


def promotion_to_wire(state: PromotionState) -> dict[str, Any]:
    out: dict[str, Any] = {
        "artifactId": state.artifactId,
        "status": state.status,
        "updatedAt": state.updatedAt,
        "data": state.data,
    }
    if state.tenant is not None:
        out["tenant"] = state.tenant
    if state.revision is not None:
        out["revision"] = state.revision
    return out


def promotion_from_wire(data: dict[str, Any]) -> PromotionState:
    return PromotionState(
        artifactId=str(data.get("artifactId", "")),
        status=str(data.get("status", "")),
        updatedAt=str(data.get("updatedAt", "")),
        data=data.get("data") or {},
        tenant=data.get("tenant"),
        revision=data.get("revision"),
    )


def fixation_to_wire(record: FixationRecord) -> dict[str, Any]:
    out: dict[str, Any] = {
        "intentHash": record.intentHash,
        "canonical": record.canonical,
        "structureHash": record.structureHash,
        "pinnedSpec": record.pinnedSpec.to_wire(),
        "fixatedAt": record.fixatedAt,
        # TS omits undefined. dataclasses.asdict would explicitly output name/roles' None, making it
        # wire-incompatible, so, like the other _*_to_wire, we build it omitting None keys.
        "approver": {
            "id": record.approver.id,
            **({"name": record.approver.name} if record.approver.name is not None else {}),
            **({"roles": record.approver.roles} if record.approver.roles is not None else {}),
        },
    }
    if record.catalogFingerprint is not None:
        out["catalogFingerprint"] = record.catalogFingerprint
    if record.tenant is not None:
        out["tenant"] = record.tenant
    if record.revision is not None:
        out["revision"] = record.revision
    return out


def fixation_from_wire(data: dict[str, Any]) -> FixationRecord:
    approver = data.get("approver") or {}
    return FixationRecord(
        intentHash=str(data.get("intentHash", "")),
        canonical=str(data.get("canonical", "")),
        structureHash=str(data.get("structureHash", "")),
        pinnedSpec=UISpec.model_validate(data["pinnedSpec"]),
        fixatedAt=str(data.get("fixatedAt", "")),
        approver=Principal(
            id=str(approver.get("id", "")),
            name=approver.get("name"),
            roles=approver.get("roles"),
        ),
        catalogFingerprint=data.get("catalogFingerprint"),
        tenant=data.get("tenant"),
        revision=data.get("revision"),
    )


def spec_to_json(spec: UISpec) -> str:
    """The text a shared-backend adapter stores for a Spec (cache entry)."""
    return dumps_compact(spec.to_wire())


def spec_from_json(raw: str) -> UISpec:
    return UISpec.model_validate(json.loads(raw))
