"""Key layout of the Redis StoragePort and the revocation store (port of packages/storage-redis/src/keys.ts).

Every key starts with a configurable prefix (default "kohaku") so several kohaku hosts can share one Redis
database. Tenant-scoped kinds (promotion / fixation) put the tenant right after the prefix:
``{prefix}:{tenant}:{kind}:{id}``; a tenant-neutral record (no tenant = the single-tenant / legacy contract) uses
"%" as its tenant segment, which a real tenant can never produce because tenants are percent-encoded ("%" itself
becomes "%25").

**The layout is shared byte-for-byte with the TS adapter** (a TS host and a Python host can serve one Redis), so
nothing in this package builds a Redis key string outside this file, and the tests pin literal keys that the TS
tests pin too.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal
from urllib.parse import quote

from kohaku.spec import normalize_tenant

DEFAULT_KEY_PREFIX = "kohaku"

NEUTRAL_TENANT_SEGMENT = "%"

# JavaScript's encodeURIComponent leaves exactly these punctuation characters (plus letters and digits)
# unescaped; urllib's quote() always keeps "_.-~" and, unlike encodeURIComponent, escapes "!*'()" unless told
# otherwise -- and keeps "/" unless safe="" is given. Both must match for the key to match TS's.
_URI_COMPONENT_SAFE = "-_.!~*'()"


def tenant_segment(tenant: str | None) -> str:
    """`tenant`, after `normalize_tenant` (None / "" both collapse to "unspecified"), percent-encoded exactly as
    JavaScript's encodeURIComponent does, or ``NEUTRAL_TENANT_SEGMENT`` when unspecified."""
    normalized = normalize_tenant(tenant)
    return (
        NEUTRAL_TENANT_SEGMENT
        if normalized is None
        else quote(normalized, safe=_URI_COMPONENT_SAFE)
    )


@dataclass(frozen=True)
class LineageKeys:
    seq: str
    events: str
    by_seq: str
    index: Callable[[str, str], str]
    """``index(field, value)``: the sorted set of event ids whose `field` equals `value`, scored by append seq."""


@dataclass(frozen=True)
class RedisKeys:
    spec: Callable[[str], str]
    lineage: LineageKeys
    promotion: Callable[[str | None, str], str]
    promotion_index: Callable[[str | None], str]
    """Per-tenant index when a tenant is given; the all-tenants index otherwise."""
    promotion_seq: str
    fixation: Callable[[str | None, str], str]
    fixation_index: Callable[[str | None], str]
    fixation_seq: str
    revoked: Callable[[str], str]
    """Capability revocation record for `jti` (``create_redis_revocation_store``)."""


def redis_keys(prefix: str = DEFAULT_KEY_PREFIX) -> RedisKeys:
    def tenant_or_all_index(kind: Literal["promotion", "fixation"]) -> Callable[[str | None], str]:
        def index(tenant: str | None) -> str:
            normalized = normalize_tenant(tenant)
            if normalized is None:
                return f"{prefix}:{kind}:index"
            return f"{prefix}:{tenant_segment(normalized)}:{kind}:index"

        return index

    return RedisKeys(
        spec=lambda key: f"{prefix}:spec:{key}",
        lineage=LineageKeys(
            seq=f"{prefix}:lineage:seq",
            events=f"{prefix}:lineage:events",
            by_seq=f"{prefix}:lineage:by-seq",
            index=lambda field, value: f"{prefix}:lineage:idx:{field}:{value}",
        ),
        promotion=lambda tenant, artifact_id: (
            f"{prefix}:{tenant_segment(tenant)}:promotion:{artifact_id}"
        ),
        promotion_index=tenant_or_all_index("promotion"),
        promotion_seq=f"{prefix}:promotion:seq",
        fixation=lambda tenant, intent_hash: (
            f"{prefix}:{tenant_segment(tenant)}:fixation:{intent_hash}"
        ),
        fixation_index=tenant_or_all_index("fixation"),
        fixation_seq=f"{prefix}:fixation:seq",
        revoked=lambda jti: f"{prefix}:revoked:{jti}",
    )
