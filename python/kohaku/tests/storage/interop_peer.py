"""The Python half of the cross-language backend test (driven by the TS vitest suites
packages/storage-redis/test/python-interop.test.ts and packages/storage-postgres/test/python-interop.test.ts, so
it runs in the CI `adapters` job next to the backend services; it is not a pytest module).

Usage: ``python interop_peer.py <redis|postgres> <backend url> <namespace> <command>``, where the namespace is the
Redis key prefix / the Postgres schema both languages are pointed at, and the command is one of:

- ``adopt``: a TS host already wrote promotion state, a fixation, a Spec cache entry, a lineage event and a
  revocation under the namespace. Read all of it, compare-and-set both records forward (and prove a stale expectation
  conflicts), and write a lineage event, a Spec cache entry and a revocation of our own. Prints what it read.
- ``seed``: write the same kinds of record (this side first), for the TS host to read and compare-and-set forward.
- ``verify``: read back what the TS host did to the ``seed`` records and exit non-zero if anything is off.

Everything printed is one JSON document on stdout; a failure is a non-zero exit with the reason on stderr.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

from kohaku.spec import (
    FixationRecord,
    LineageActor,
    LineageEventRecord,
    LineageFilter,
    LineagePageRequest,
    Principal,
    PromotionState,
    StorageConflictError,
    UISpec,
)
from kohaku.storage._wire import fixation_to_wire, promotion_to_wire

REPO_ROOT = Path(__file__).resolve().parents[4]
EXAMPLE_SPEC = REPO_ROOT / "spec" / "examples" / "quarterly-sales.spec.json"

TENANT = "acme"
EVENT_TS = "2026-02-01T00:00:00.000Z"


def example_spec() -> UISpec:
    return UISpec.model_validate(json.loads(EXAMPLE_SPEC.read_text(encoding="utf-8")))


def _promotion(revision: str, status: str) -> PromotionState:
    return PromotionState(
        artifactId="a1",
        status=status,
        updatedAt=EVENT_TS,
        data={"verdict": {"ok": True, "by": "python"}, "zzz": 1},
        tenant=TENANT,
        revision=revision,
    )


def _fixation(revision: str, fingerprint: str) -> FixationRecord:
    return FixationRecord(
        intentHash="sha256:interop",
        canonical="sales.trend",
        structureHash="sha256:s",
        pinnedSpec=example_spec(),
        fixatedAt=EVENT_TS,
        approver=Principal(id="admin", name="Ada", roles=["admin"]),
        catalogFingerprint=fingerprint,
        tenant=TENANT,
        revision=revision,
    )


def _event(event_id: str, correlation_id: str) -> LineageEventRecord:
    return LineageEventRecord(
        id=event_id,
        ts=EVENT_TS,
        actor=LineageActor(kind="system"),
        type="view.composed",
        payload={"intentHash": "sha256:interop", "correlationId": correlation_id},
        tenant=TENANT,
    )


class Backend:
    """The storage port and the revocation store for the backend under test, opened in this process's loop."""

    def __init__(self, kind: str, url: str, namespace: str) -> None:
        self.kind = kind
        if kind == "redis":
            from kohaku.storage.redis import (
                create_redis_revocation_store,
                create_redis_storage_port,
            )

            self.storage: Any = create_redis_storage_port(url=url, key_prefix=namespace)
            self.revocations: Any = create_redis_revocation_store(url=url, key_prefix=namespace)
        elif kind == "postgres":
            from kohaku.storage.postgres import (
                create_postgres_revocation_store,
                create_postgres_storage_port,
            )

            self.storage = create_postgres_storage_port(connection_string=url, schema=namespace)
            self.revocations = create_postgres_revocation_store(
                connection_string=url, schema=namespace
            )
        else:
            raise SystemExit(f"unknown backend {kind!r}")

    async def close(self) -> None:
        await self.storage.close()
        await self.revocations.close()


def _fail(message: str) -> None:
    print(f"interop_peer: {message}", file=sys.stderr)
    raise SystemExit(1)


async def adopt(backend: Backend) -> dict[str, Any]:
    storage = backend.storage
    promotion = await storage.get_promotion_state("a1", TENANT)
    fixation = await storage.get_fixation("sha256:interop", TENANT)
    spec = await storage.get_spec_cache("ts-spec")
    if promotion is None or fixation is None or spec is None:
        _fail("the TS host's records are missing")
    seen = {
        "promotion": promotion_to_wire(promotion),
        "fixation": fixation_to_wire(fixation),
        "spec": spec.to_wire(),
        "tenantPromotions": [s.artifactId for s in await storage.list_promotion_states(TENANT)],
        "tenantFixations": [f.intentHash for f in await storage.list_fixations(TENANT)],
        "lineageIds": [e.id for e in await storage.list_lineage()],
        "lineageByCorrelation": [
            e.id for e in await storage.list_lineage(LineageFilter(correlationId="ts-corr"))
        ],
        "lineageByTenant": [e.id for e in await storage.list_lineage(LineageFilter(tenant=TENANT))],
        "tsRevoked": await backend.revocations.is_revoked("ts-jti"),
    }

    # Compare-and-set both records forward from the revision the TS host stamped.
    await storage.put_promotion_state(
        _promotion("py-1", "approved"), expected_revision=promotion.revision
    )
    await storage.put_fixation(_fixation("py-1", "fp-py"), expected_revision=fixation.revision)
    stale_conflict = False
    try:
        await storage.put_promotion_state(_promotion("py-2", "rejected"), expected_revision="stale")
    except StorageConflictError:
        stale_conflict = True

    # Records of our own, for the TS host to read.
    await storage.append_lineage(_event("py-event", "py-corr"))
    await storage.put_spec_cache("py-spec", example_spec())
    await backend.revocations.revoke("py-jti", int(time.time()) + 3600)
    page = await storage.page_lineage(LineagePageRequest(pageSize=100))
    return {
        "seen": seen,
        "staleConflict": stale_conflict,
        "pageIds": [e.id for e in page.events],
    }


async def seed(backend: Backend) -> dict[str, Any]:
    storage = backend.storage
    await storage.put_promotion_state(_promotion("py-0", "candidate"), expected_revision=None)
    await storage.put_fixation(_fixation("py-0", "fp-py-0"), expected_revision=None)
    await storage.put_spec_cache("py-spec", example_spec())
    await storage.append_lineage(_event("py-event", "py-corr"))
    await backend.revocations.revoke("py-jti", int(time.time()) + 3600)
    return {"seeded": True}


async def verify(backend: Backend) -> dict[str, Any]:
    storage = backend.storage
    promotion = await storage.get_promotion_state("a1", TENANT)
    fixation = await storage.get_fixation("sha256:interop", TENANT)
    if promotion is None or promotion.revision != "ts-1" or promotion.status != "approved":
        _fail(f"the TS host's promotion update is not visible: {promotion}")
    if fixation is None or fixation.revision != "ts-1" or fixation.catalogFingerprint != "fp-ts":
        _fail(f"the TS host's fixation update is not visible: {fixation}")
    if fixation.pinnedSpec != example_spec():
        _fail("the pinned Spec did not survive a round trip through the TS host")
    ids = [e.id for e in await storage.list_lineage()]
    if ids != ["py-event", "ts-event"]:
        _fail(f"unexpected lineage order {ids}")
    page_ids = [e.id for e in (await storage.page_lineage(LineagePageRequest(pageSize=1))).events]
    if page_ids != ["py-event"]:
        _fail(f"unexpected first lineage page {page_ids}")
    by_correlation = [
        e.id for e in await storage.list_lineage(LineageFilter(correlationId="ts-corr"))
    ]
    if by_correlation != ["ts-event"]:
        _fail(f"the TS host's lineage event is not found by its correlation id: {by_correlation}")
    if not await backend.revocations.is_revoked("ts-jti"):
        _fail("the TS host's revocation is not visible")
    return {"verified": True}


COMMANDS = {"adopt": adopt, "seed": seed, "verify": verify}


async def main(argv: list[str]) -> None:
    if len(argv) != 5 or argv[4] not in COMMANDS:
        raise SystemExit(__doc__)
    backend = Backend(argv[1], argv[2], argv[3])
    try:
        print(json.dumps(await COMMANDS[argv[4]](backend)))
    finally:
        await backend.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv))
