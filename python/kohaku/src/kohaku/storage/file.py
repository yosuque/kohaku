"""File-based StoragePort implementation (port of apps/sample-api/src/ports/storage-port.ts).

The Spec cache is in-memory (approximate LRU + TTL); Lineage / promotion / fixation are persisted to disk.

Persistence hardening and its limits (same as the TS version):
- Snapshots (promotions / fixations) are replaced atomically via tmp+rename.
- Each put is "re-read the disk → swap only that entry → write it back atomically".
- The gap between read→rename is non-atomic, so a lost update can occur under truly concurrent writes
  (robust sharing presupposes a single writer / file lock / DB).
- lineage is only an in-memory array + appends to lineage.jsonl (no rotation / compaction). For production
  use, the intent is to replace it with a dedicated event store / DB.

Async I/O (mirrors the TS port's `fs/promises` + keyed-mutex design): every method that touches disk offloads
the actual (blocking, synchronous) file I/O to a worker thread via `asyncio.to_thread`, so one request's
snapshot read-modify-write does not stall the event loop for concurrent requests. A read-modify-write against
the *same* snapshot file (promotions.json / fixations.json) is additionally serialized by a per-path
`asyncio.Lock` (`_lock_for`), the same role TS's `createKeyedMutex` plays — two concurrent puts, even for
different tenant/id keys, cannot race and lose each other's entry within this process. As in the TS port, this
only orders calls *within one process*; cross-process concurrency (e.g. sample-api and sample-mcp sharing one
data directory) can still lose an update (see the class docstring below for the same caveat spelled out for
put/delete).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
import uuid
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import Any

from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    Principal,
    PromotionState,
    UISpec,
)

_MAX_SPEC_CACHE_ENTRIES = 500
"""Entry cap of the in-memory Spec cache. On overflow, drop the oldest (approximate LRU)."""


def _fixation_key(tenant: str | None, intent_hash: str) -> str:
    """Composite key of (tenant, intentHash). Without a tenant, it is intentHash itself (byte-identical to the
    old file's key = compatible load). The NUL separator does not collide."""
    return f"{tenant}\x00{intent_hash}" if tenant else intent_hash


def _promotion_key(tenant: str | None, artifact_id: str) -> str:
    return f"{tenant}\x00{artifact_id}" if tenant else artifact_id


def _lineage_to_wire(event: LineageEventRecord) -> dict[str, Any]:
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


def _lineage_from_wire(data: dict[str, Any]) -> LineageEventRecord:
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


def _promotion_to_wire(state: PromotionState) -> dict[str, Any]:
    out: dict[str, Any] = {
        "artifactId": state.artifactId,
        "status": state.status,
        "updatedAt": state.updatedAt,
        "data": state.data,
    }
    if state.tenant is not None:
        out["tenant"] = state.tenant
    return out


def _promotion_from_wire(data: dict[str, Any]) -> PromotionState:
    return PromotionState(
        artifactId=str(data.get("artifactId", "")),
        status=str(data.get("status", "")),
        updatedAt=str(data.get("updatedAt", "")),
        data=data.get("data") or {},
        tenant=data.get("tenant"),
    )


def _fixation_to_wire(record: FixationRecord) -> dict[str, Any]:
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


def _fixation_from_wire(data: dict[str, Any]) -> FixationRecord:
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


class FileStoragePort:
    """StoragePort implementation. The Spec cache is in memory; governance state is persisted to disk."""

    def __init__(self, data_dir: str | Path) -> None:
        self._dir = Path(data_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lineage_path = self._dir / "lineage.jsonl"
        self._promotions_path = self._dir / "promotions.json"
        self._fixations_path = self._dir / "fixations.json"

        # One asyncio.Lock per snapshot file path (lazily created by _lock_for), serializing concurrent
        # put/delete calls against the *same* file within this process (TS's createKeyedMutex counterpart).
        self._locks: dict[Path, asyncio.Lock] = {}

        # Keep the dict's insertion order as "most recently touched" to approximate LRU (re-insert on a get hit).
        self._spec_cache: dict[str, tuple[UISpec, float | None]] = {}
        self._lineage: list[LineageEventRecord] = [
            _lineage_from_wire(d) for d in _load_jsonl(self._lineage_path)
        ]
        self._promotions: dict[str, PromotionState] = _load_records(
            self._promotions_path, _promotion_from_wire
        )
        self._fixations: dict[str, FixationRecord] = _load_records(
            self._fixations_path, _fixation_from_wire
        )

    async def get_spec_cache(self, key: str) -> UISpec | None:
        entry = self._spec_cache.get(key)
        if entry is None:
            return None
        spec, expires_at = entry
        if expires_at is not None and expires_at < time.time():
            del self._spec_cache[key]
            return None
        # Re-insert the hit entry at the end to maintain the LRU "recently used" order.
        del self._spec_cache[key]
        self._spec_cache[key] = entry
        return spec

    async def put_spec_cache(
        self, key: str, spec: UISpec, *, ttl_seconds: int | None = None
    ) -> None:
        self._spec_cache.pop(key, None)
        self._spec_cache[key] = (
            spec,
            time.time() + ttl_seconds if ttl_seconds is not None else None,
        )
        while len(self._spec_cache) > _MAX_SPEC_CACHE_ENTRIES:
            oldest = next(iter(self._spec_cache))
            del self._spec_cache[oldest]

    async def append_lineage(self, event: LineageEventRecord) -> None:
        # Offloaded to a worker thread so a large/slow disk append does not block the event loop (R6/D6). Not
        # lock-guarded (matches the TS port): under concurrent appends the completion order is not guaranteed
        # to follow ts order, a known constraint documented on both ports; order-sensitive consumers compare ts.
        def _write() -> None:
            with self._lineage_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(_lineage_to_wire(event), ensure_ascii=False) + "\n")

        await asyncio.to_thread(_write)
        # Reflect to memory only after the append succeeds (so memory and disk do not diverge on append failure).
        self._lineage.append(event)

    async def list_lineage(self, filter: LineageFilter | None = None) -> list[LineageEventRecord]:
        f = filter or LineageFilter()
        result = self._lineage
        if f.type is not None:
            allowed = set(f.type)
            result = [e for e in result if e.type in allowed]
        if f.tenant is not None:
            result = [e for e in result if e.tenant == f.tenant]
        if f.intentHash is not None:
            result = [e for e in result if e.payload.get("intentHash") == f.intentHash]
        if f.artifactId is not None:
            result = [e for e in result if e.payload.get("artifactId") == f.artifactId]
        if f.specHash is not None:
            result = [e for e in result if e.payload.get("specHash") == f.specHash]
        if f.since is not None:
            result = [e for e in result if e.ts >= f.since]
        # Apply until "before" the tail slice (otherwise the latest limit items would be entirely excluded and the window would be nearly empty).
        if f.until is not None:
            result = [e for e in result if e.ts <= f.until]
        limit = f.limit if f.limit is not None else 200
        return result[-limit:] if limit > 0 else []

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None:
        return self._promotions.get(_promotion_key(tenant, artifact_id))

    async def put_promotion_state(self, state: PromotionState) -> None:
        await self._merge_put(
            self._promotions_path,
            self._promotions,
            _promotion_key(state.tenant, state.artifactId),
            state,
            _promotion_to_wire,
            _promotion_from_wire,
        )

    async def list_promotion_states(self, tenant: str | None = None) -> list[PromotionState]:
        values = list(self._promotions.values())
        return values if tenant is None else [s for s in values if s.tenant == tenant]

    async def get_fixation(
        self, intent_hash: str, tenant: str | None = None
    ) -> FixationRecord | None:
        return self._fixations.get(_fixation_key(tenant, intent_hash))

    async def put_fixation(self, record: FixationRecord, *, if_present: bool = False) -> None:
        await self._merge_put(
            self._fixations_path,
            self._fixations,
            _fixation_key(record.tenant, record.intentHash),
            record,
            _fixation_to_wire,
            _fixation_from_wire,
            if_present=if_present,
        )

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]:
        values = list(self._fixations.values())
        return values if tenant is None else [f for f in values if f.tenant == tenant]

    async def delete_fixation(self, intent_hash: str, tenant: str | None = None) -> None:
        key = _fixation_key(tenant, intent_hash)

        def _do() -> None:
            loaded, corrupted = _load_json_snapshot(self._fixations_path, {})
            base = (
                {k: _fixation_to_wire(v) for k, v in self._fixations.items()} if corrupted else loaded
            )
            base.pop(key, None)
            _write_json_atomic(self._fixations_path, base)
            self._fixations.clear()
            self._fixations.update({k: _fixation_from_wire(v) for k, v in base.items()})

        async with self._lock_for(self._fixations_path):
            await asyncio.to_thread(_do)

    def _lock_for(self, path: Path) -> asyncio.Lock:
        """Lazily creates (and thereafter reuses) one asyncio.Lock per snapshot file path, so put/delete calls
        that target the same file serialize their read-modify-write within this process (see the module
        docstring; this is the Python counterpart of the TS port's keyed mutex)."""
        lock = self._locks.get(path)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[path] = lock
        return lock

    async def _merge_put[T](
        self,
        path: Path,
        memory: dict[str, T],
        key: str,
        value: T,
        to_wire: Any,
        from_wire: Any,
        *,
        if_present: bool = False,
    ) -> None:
        """Read the latest from disk, update that key, write it back atomically, and sync memory too.

        On disk corruption, use **the memory Map as the merge base** rather than fallback({}) (using
        corruption as the base would collapse all healthy state into that single entry and lose it; the
        corrupted file has already been moved aside to .corrupt).

        if_present: skip the write-back (memory is still synced to the freshly re-read base) unless `key` is
        already present there. Used by Fixations.refresh_fingerprint (via put_fixation's if_present) so a
        self-healing get->put that races with a concurrent delete does not resurrect an already-removed
        fixation — and, since memory is synced to the current disk truth even on this no-op path, the
        caller's own stale in-memory copy of the deleted record is dropped too rather than lingering until an
        unrelated key's put happens to resync it.

        The actual disk I/O and memory sync run in a worker thread (`asyncio.to_thread`) so they do not block
        the event loop, guarded by `_lock_for(path)` so two concurrent calls against the same file cannot
        interleave their read-modify-write and lose one another's entry (R6/D6).
        """

        def _do() -> None:
            loaded, corrupted = _load_json_snapshot(path, {})
            base = {k: to_wire(v) for k, v in memory.items()} if corrupted else loaded
            skip_write = if_present and key not in base
            if not skip_write:
                base[key] = to_wire(value)
                _write_json_atomic(path, base)
            memory.clear()
            memory.update({k: from_wire(v) for k, v in base.items()})

        async with self._lock_for(path):
            await asyncio.to_thread(_do)


class MemoryStoragePort(FileStoragePort):
    """Disposable storage implementation for test / ephemeral use (not truly in-memory).

    Its substance is "disposable files created under the system temp directory": a simple version that uses
    FileStoragePort as-is and gives it an auto-generated temp directory as data_dir (the Spec cache is in
    memory; governance state is files under that temp directory). The temp directory is reclaimed at instance
    GC, or via close(). The public API is unchanged (usable with no constructor arguments).
    """

    def __init__(self) -> None:
        import tempfile

        # TemporaryDirectory auto-reclaims at GC via an internal weakref.finalize (explicit close() also works).
        # Because it actually writes disposable files to data_dir, unlike the old mkdtemp version it has a means of cleanup.
        self._tmpdir = tempfile.TemporaryDirectory(prefix="kohaku-storage-")
        super().__init__(self._tmpdir.name)

    def close(self) -> None:
        """Explicitly reclaim the temp directory (when you want to clean up without waiting for GC; safe to call multiple times)."""
        self._tmpdir.cleanup()


def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
    """Atomic write that writes to tmp then renames (process-crash resilience only; no fsync).

    The tmp name gets a unique suffix (uuid4) in addition to the PID, so that even when two runs in different
    PID namespaces (containers) happen to share a PID, the tmp files do not collide. On any failure after the
    tmp file is created (write or replace), the tmp file is removed so a failed write does not leave orphaned
    `*.tmp` files behind (TS: writeJsonAtomic mirrors the same try/finally cleanup).
    """
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp")
    renamed = False
    try:
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        renamed = True
    finally:
        if not renamed:
            tmp.unlink(missing_ok=True)


def _load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if line.strip() == "":
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            # Skip a trailing in-progress line or corrupted line (recovery from a crash mid-append).
            # In stdio MCP, stdout is the JSON-RPC channel, so warnings go to stderr (equivalent to TS's console.warn).
            print("[storage] Skipped a malformed line in lineage.jsonl", file=sys.stderr)
    return out


def _load_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    return _load_json_snapshot(path, fallback)[0]


def _load_records[T](path: Path, from_wire: Callable[[dict[str, Any]], T]) -> dict[str, T]:
    """Load a snapshot as {key -> T}, tolerating per-entry corruption.

    A malformed *individual* record (unlike a corrupted file root, already handled by
    _load_json_snapshot's root-shape check) must not prevent the rest of a healthy file from loading — the
    TS port's loader has always been record-level tolerant (skips only the one bad JSONL line / snapshot
    entry), while this port previously let one bad record raise out of __init__ and abort startup entirely.
    Skipped entries are counted and reported once via warnings.warn (visible to library users who configure
    warning filters) and a stderr line (matching the module's other startup diagnostics; stdout would pollute
    stdio MCP's JSON-RPC channel).
    """
    raw = _load_json(path, {})
    result: dict[str, T] = {}
    skipped = 0
    for key, value in raw.items():
        try:
            result[key] = from_wire(value)
        except Exception:
            skipped += 1
    if skipped > 0:
        message = f"[storage] {path}: skipped {skipped} malformed record(s)"
        warnings.warn(message, stacklevel=2)
        print(message, file=sys.stderr)
    return result


def _load_json_snapshot(
    path: Path, fallback: dict[str, Any]
) -> tuple[dict[str, Any], bool]:
    """Read a snapshot JSON and return it along with whether corruption was detected.

    On corruption, move it aside to .corrupt so it is noticeable, then return fallback.
    """
    if not path.exists():
        return fallback, False
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        assert isinstance(data, dict)
        return data, False
    except (json.JSONDecodeError, AssertionError):
        try:
            backup = path.with_name(f"{path.name}.{int(time.time() * 1000)}.corrupt")
            path.replace(backup)
            # stdout would pollute the stdio MCP JSON-RPC channel, so use stderr (equivalent to TS's console.warn).
            print(f"[storage] {path} was corrupted, so it was moved aside to {backup}", file=sys.stderr)
        except OSError:
            print(f"[storage] {path} is corrupted", file=sys.stderr)
        return fallback, True
