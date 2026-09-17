"""Shared in-process keyed serialization lock (port of packages/host-core/src/keyed-mutex.ts).

Extracted from kohaku.host_rest's `_routes.shared` module (the original site of this implementation — see
that module's re-export of `_get_lock` / `_locks` for backward compatibility) so kohaku.host_mcp can consume
the identical mechanism for its fixation self-heal serialization, exactly as TS's `host-mcp-apps/src/server.ts`
consumes `@kohaku-ui/host-core`'s `createKeyedMutex` (the same relationship this module has with
`packages/host-rest/src/keyed-mutex.ts`'s re-export).

Unlike the TS port (a factory `createKeyedMutex()` returning a per-instance `KeyedMutex` closure over its own
`Map`), this is a single process-wide table keyed by `(event loop, owner, key)`: `owner` (typically a
`KohakuHostDeps` / `McpHostDeps` instance, compared via `id()`) plays the role TS's separate mutex-per-deps
`WeakMap` plays — scoping locks to one host instance so unrelated hosts sharing a process never contend on the
same lock — while the loop id makes this safe even for a test client that spans event loops (within the same
loop it is serialized).

Serializes the read-modify-write of promotion / fixation state across both host profiles: host_rest's
promotion lock and fixation lock, and host_mcp's fixation self-heal serialization (keyed by `intentHash`
alone, since the MCP profile never resolves a tenant). It only orders calls made *within this process*; see
`StoragePort`'s docstring (kohaku.spec) for the cross-process concurrency contract this mechanism sits on top
of.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from dataclasses import dataclass, field


@dataclass
class _LockEntry:
    """A serialization lock and its user count (held + waiting to acquire). Cleaned up from `_locks` when it
    reaches 0."""

    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0


_locks: dict[tuple[int, int, str], _LockEntry] = {}


@contextlib.asynccontextmanager
async def get_lock(owner: object, key: str) -> AsyncIterator[None]:
    """async context manager acquiring a per-(loop, owner, key) in-process serialization lock.

    Reference-counts the users and removes the entry from `_locks` when the last user leaves (without relying
    on asyncio.Lock private attributes). There is no await between get and increment (atomic under
    single-threaded asyncio), and waiters are also counted as users, so the entry is not cleaned up while any
    waiter remains.
    """
    loop_id = id(asyncio.get_running_loop())
    composite = (loop_id, id(owner), key)
    entry = _locks.get(composite)
    if entry is None:
        entry = _LockEntry()
        _locks[composite] = entry
    entry.users += 1
    try:
        async with entry.lock:
            yield
    finally:
        entry.users -= 1
        # If we are the last user (no waiters and no holder), clean up the entry.
        if entry.users == 0 and _locks.get(composite) is entry:
            del _locks[composite]
