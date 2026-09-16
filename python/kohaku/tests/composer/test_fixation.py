"""Tests for materialize_fixation (fixation short-circuit)."""

from __future__ import annotations

import asyncio
from typing import Any

from kohaku.composer import ComposeContext, materialize_fixation
from kohaku.llm import FakeLlm
from kohaku.registry import core_catalog, resolve_catalog
from kohaku.spec import (
    DataShape,
    FixationRecord,
    Intent,
    IntentInput,
    Principal,
    QueryHandle,
    UISpec,
    compute_structure_hash,
    finalize_intent,
)
from kohaku.storage import FileStoragePort

_CATALOG = resolve_catalog(core_catalog())
_REF = "query://sales/summary?fy=2026"


class _Semantic:
    def __init__(self, uris: list[str] | None = None) -> None:
        self._uris = uris if uris is not None else [_REF]

    async def normalize(self, input: Any, ctx: Any) -> IntentInput:
        raise NotImplementedError

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        return [QueryHandle(uri=u) for u in self._uris]

    async def data_version(self, handle: QueryHandle) -> str:
        return "v2"  # a newer version than at fixation time (v1)

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        return None


def _intent() -> Intent:
    return finalize_intent(IntentInput(canonical="sales.summary", params={"fy": 2026}))


def _pinned_spec() -> UISpec:
    return UISpec.model_validate(
        {
            "kohaku": "0.2",
            "intent": _intent().to_wire(),
            "dataVersion": "v1",
            "refVersions": {_REF: "v1"},
            "components": [
                {"id": "root", "type": "layout.stack", "props": {}, "children": ["t"]},
                {"id": "t", "type": "presentSpreadsheet", "props": {}, "data": {"$ref": _REF}},
            ],
            "provenance": {"tier": "L1", "composedBy": "composer@0.1.0", "cache": "miss"},
        }
    )


def _fixation(fingerprint: str | None) -> FixationRecord:
    pinned = _pinned_spec()
    return FixationRecord(
        intentHash=_intent().hash,
        canonical="sales.summary",
        # The real structureHash of pinned (not a placeholder): materialize_fixation now verifies this
        # matches its pinnedSpec.
        structureHash=compute_structure_hash(pinned),
        pinnedSpec=pinned,
        fixatedAt="2026-07-17T00:00:00Z",
        approver=Principal(id="admin"),
        catalogFingerprint=fingerprint,
    )


def _ctx(semantic: _Semantic | None = None, tmp_path: Any = None) -> ComposeContext:
    import tempfile

    return ComposeContext(
        catalog=_CATALOG,
        semantic=semantic if semantic is not None else _Semantic(),
        storage=FileStoragePort(tmp_path if tmp_path is not None else tempfile.mkdtemp()),
        llm=FakeLlm(),
    )


def test_fresh_when_fingerprint_matches(tmp_path: Any) -> None:
    async def run() -> None:
        result, check = await materialize_fixation(
            _fixation(_CATALOG.fingerprint), _intent(), _ctx(tmp_path=tmp_path)
        )
        assert check.kind == "fresh"
        assert result is not None
        spec = result.spec
        assert spec.provenance.tier == "L0"
        assert spec.provenance.cache == "fixated"
        # refVersions drops the old version at fixation time (v1) and re-fills with the latest version (v2)
        assert spec.refVersions == {_REF: "v2"}
        assert spec.dataVersion == "v2"
        assert result.trace.cache == "fixated"
        assert result.trace.cacheKey == f"fixated:{_intent().hash}"

    asyncio.run(run())


def test_stale_when_pinned_spec_is_corrupted(tmp_path: Any) -> None:
    """A pinnedSpec that fails UISpec's own schema (e.g. empty components) must never be delivered, even
    when the catalog fingerprint matches (§4.3 A10) — a stand-in for a corrupted/hand-edited
    fixations.json entry or a non-conforming StoragePort implementation that skips validation on read.
    dataclasses.replace bypasses UISpec's own construction-time validation (a dataclass field is not
    type-checked at runtime), simulating a StoragePort that returns an unvalidated pinnedSpec."""
    from dataclasses import replace
    from typing import cast

    async def run() -> None:
        fixation = _fixation(_CATALOG.fingerprint)
        pinned_wire = _pinned_spec().to_wire()
        pinned_wire["components"] = []
        corrupted = cast(UISpec, pinned_wire)

        result, check = await materialize_fixation(
            replace(fixation, pinnedSpec=corrupted), _intent(), _ctx(tmp_path=tmp_path)
        )
        assert check.kind == "stale"
        assert result is None
        assert check.issues is not None
        assert any("schema validation" in i for i in check.issues)

    asyncio.run(run())


def test_revalidated_when_fingerprint_differs_but_valid(tmp_path: Any) -> None:
    async def run() -> None:
        result, check = await materialize_fixation(
            _fixation("0" * 16), _intent(), _ctx(tmp_path=tmp_path)
        )
        assert check.kind == "revalidated"
        assert result is not None

    asyncio.run(run())


def test_stale_when_catalog_rejects(tmp_path: Any) -> None:
    async def run() -> None:
        fixation = _fixation("0" * 16)
        broken = fixation.pinnedSpec.model_copy(
            update={
                "components": [
                    c.model_copy(update={"type": "no.such"}) if c.id == "t" else c
                    for c in fixation.pinnedSpec.components
                ]
            }
        )
        from dataclasses import replace

        result, check = await materialize_fixation(
            replace(fixation, pinnedSpec=broken), _intent(), _ctx(tmp_path=tmp_path)
        )
        assert check.kind == "stale"
        assert result is None

    asyncio.run(run())


def test_stale_on_ref_drift(tmp_path: Any) -> None:
    """stale when the resolved URI set drifts from fixation time (the keys of refVersions)."""

    async def run() -> None:
        semantic = _Semantic(uris=[_REF, "query://sales/extra?x=1"])  # added
        result, check = await materialize_fixation(
            _fixation(_CATALOG.fingerprint), _intent(), _ctx(semantic, tmp_path)
        )
        assert check.kind == "stale"
        assert result is None
        assert check.issues is not None and "added" in check.issues[0]

    asyncio.run(run())


def test_stale_when_intent_hash_mismatches(tmp_path: Any) -> None:
    """A hand-edited record whose intentHash no longer matches the requested intent is stale."""
    from dataclasses import replace

    async def run() -> None:
        fixation = _fixation(_CATALOG.fingerprint)
        tampered = replace(fixation, intentHash="sha256:" + "9" * 64)

        result, check = await materialize_fixation(tampered, _intent(), _ctx(tmp_path=tmp_path))
        assert check.kind == "stale"
        assert result is None
        assert check.issues is not None
        assert any("intentHash" in i for i in check.issues)

    asyncio.run(run())


def test_stale_when_structure_hash_mismatches(tmp_path: Any) -> None:
    """A hand-edited record whose structureHash no longer matches its pinnedSpec is stale."""
    from dataclasses import replace

    async def run() -> None:
        fixation = _fixation(_CATALOG.fingerprint)
        tampered = replace(fixation, structureHash="sha256:" + "9" * 64)

        result, check = await materialize_fixation(tampered, _intent(), _ctx(tmp_path=tmp_path))
        assert check.kind == "stale"
        assert result is None
        assert check.issues is not None
        assert any("structureHash" in i for i in check.issues)

    asyncio.run(run())
