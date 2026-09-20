"""The Ports the framework defines and the product implements (port of TS ports.ts).

TS interfaces are expressed as typing.Protocol (structural subtyping). Method names use Python's snake_case
convention (they are an API the product implements, not a wire contract). Record types are dataclasses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import ValidationError

from .intent import IntentInput
from .models import (
    FixationRecordModel,
    Intent,
    JsonObject,
    PromotionStateModel,
    UISpec,
)
from .tabular import DataShape


@dataclass(frozen=True)
class Principal:
    id: str
    name: str | None = None
    roles: list[str] | None = None


type Surface = str
"""Surface identifier such as "web" / "chat" / "mcp-app" (an open string)."""


@dataclass(frozen=True)
class SessionContext:
    surface: Surface
    sessionId: str | None = None
    principal: Principal | None = None
    locale: str | None = None
    tenant: str | None = None
    """Tenant identifier (multi-tenant contract). Propagates to the aggregation scope of lineage records and promotion/fixation.

    Not included in the cache key (query:// references are tenant-neutral, and tenant filtering is done by
    the DomainPort via InvocationContext.principal / capability).
    """


@dataclass(frozen=True)
class NLQuery:
    kind: Literal["nl"]
    text: str
    locale: str | None = None


@dataclass(frozen=True)
class GuiAction:
    kind: Literal["gui"]
    action: str
    params: JsonObject
    current: Intent | None = None
    """For an operation on an existing view, the pre-operation Intent (the base for applying the diff)."""


type SemanticInput = NLQuery | GuiAction


@dataclass(frozen=True)
class QueryHandle:
    """The data reference carried in a UI Spec. Bulk data is fetched by components directly from the API."""

    uri: str
    """"query://source/path?params" """


@dataclass(frozen=True)
class OperationDescriptor:
    """Exposure of a business API. Invariants remain behind this (in the domain module)."""

    name: str
    description: str
    paramsSchema: Any = None
    """JSON Schema (doubles as the semantic-layer document in the LLM prompt)."""
    resultShape: DataShape | None = None


@dataclass(frozen=True)
class InvocationContext:
    principal: Principal
    capability: str | None = None


class DomainPort(Protocol):
    async def list_operations(self) -> list[OperationDescriptor]: ...

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object: ...


class SemanticPort(Protocol):
    """Normalized Intent → deterministic query resolution (the semantic-layer connection point).

    Tenant invariant: keep `query://` references tenant-neutral. Tenant-based data filtering is done by
    DomainPort.invoke via InvocationContext, and resolve_query / data_version do not depend on the tenant.
    Hence tenant is not included in the cache key.
    """

    async def normalize(self, input: SemanticInput, ctx: SessionContext) -> IntentInput:
        """Normalize NL / GUI input. Returns IntentInput without computing the hash.

        Computing the deterministic hash is the framework's responsibility (finalize_intent); implementers
        are not forced to supply a dummy hash.
        """
        ...

    async def resolve_query(
        self, intent: Intent, *, tenant: str | None = None
    ) -> QueryHandle | list[QueryHandle]:
        """Resolve a normalized Intent into a deterministic query (a reference-passing handle).

        tenant (optional): Intents added by promotion (publish) are independent per tenant, so this is used
        to look up per-tenant Intent definitions. The URI of the returned QueryHandle does not depend on the
        tenant.
        """
        ...

    async def data_version(self, handle: QueryHandle) -> str: ...

    async def describe_shape(self, handle: QueryHandle) -> DataShape | None:
        """Return only column metadata (never row data). Used for the chart-kind rule and props filling.

        Equivalent to a TS optional method: an implementation that does not provide a shape returns None.
        """
        ...


@dataclass(frozen=True)
class Scope:
    """One scope of an on-behalf-of capability.

    ref is the allowed query:// URI (read) / action name (write), matched by exact match. Prefix matching is
    not used because it would let value/name boundaries slip through. The issuer enumerates all bind variants
    of reachable refs, so exact matching does not reduce expressiveness.
    """

    kind: Literal["read", "write"]
    ref: str


@dataclass(frozen=True)
class VerifyRequest:
    kind: Literal["read", "write"]
    ref: str


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    principal: Principal | None = None
    reason: str | None = None


class AuthzPort(Protocol):
    async def issue_capability(
        self, principal: Principal, scopes: list[Scope], *, ttl_seconds: int | None = None
    ) -> str: ...

    async def verify(self, token: str, req: VerifyRequest) -> VerifyResult: ...


@dataclass(frozen=True)
class LineageActor:
    kind: Literal["user", "model", "system"]
    id: str | None = None
    model: str | None = None


@dataclass(frozen=True)
class LineageEventRecord:
    """Persistence record of a Lineage event (the strict schema is owned by kohaku.lineage)."""

    id: str
    ts: str
    actor: LineageActor
    type: str
    payload: dict[str, Any]
    tenant: str | None = None


@dataclass(frozen=True)
class LineageFilter:
    type: list[str] | None = None
    artifactId: str | None = None
    specHash: str | None = None
    intentHash: str | None = None
    since: str | None = None
    """Only events at or after this time (ts >= since, inclusive). Assumes canonical ISO8601 form."""
    until: str | None = None
    """At or before this time (ts <= until, inclusive). Applied before the limit tail slice."""
    limit: int | None = None
    tenant: str | None = None
    """When set, only events whose tenant matches. Legacy events without a recorded tenant appear only under an unset filter."""


@dataclass(frozen=True)
class PromotionState:
    """Snapshot of promotion state. The source of truth for reads is this snapshot (design.md §9.2).

    The persistence of put_promotion_state / list_promotion_states is the ultimate state authority (replay
    recovery from the event log is not implemented, so do not mistake this for "a projection that can be
    reconstructed if lost").
    """

    artifactId: str
    status: str
    updatedAt: str
    data: dict[str, Any] = field(default_factory=dict)
    tenant: str | None = None
    """The tenant that owns the promotion state. When omitted, tenant-neutral (equivalent to single-tenant)."""


@dataclass(frozen=True)
class FixationRecord:
    """Record of an L1→L0 fixation. Even with the structure fixed, data stays current via $ref reference-passing."""

    intentHash: str
    canonical: str
    structureHash: str
    pinnedSpec: UISpec
    fixatedAt: str
    approver: Principal
    catalogFingerprint: str | None = None
    """Catalog fingerprint at fixation time. Used to detect staleness at materialize time."""
    tenant: str | None = None
    revision: str | None = None
    """A per-write token, monotonic within this process (None = compatible with old records with none). Finer
    grained than fixatedAt (an ms-precision ISO timestamp), which cannot distinguish an unfixate -> fixate
    pair that lands inside the same millisecond. fixate() stamps a fresh one on every write; the self-healing
    TOCTOU guard (Fixations.invalidate's guard) compares this when present, falling back to fixatedAt for
    records that predate this field."""


def validate_fixation_record(raw: object) -> FixationRecord | None:
    """model_validate-equivalent for FixationRecord (port of TS FixationRecordSchema.safeParse).

    A fixation record read back from StoragePort.get_fixation has no runtime guarantee of matching the
    dataclass's declared shape (a corrupted/hand-edited fixations.json entry, or a non-conforming
    StoragePort implementation). `raw` may be a `dict` (raw wire JSON) or an already-constructed
    `FixationRecord` (validated either way via FixationRecordModel, which reuses UISpec's own pydantic
    validation for pinnedSpec). Returns the validated dataclass, or None on failure — callers (kohaku.lineage's
    Fixations service) treat None exactly like a real absence.
    """
    try:
        model = (
            FixationRecordModel.model_validate(raw)
            if isinstance(raw, dict)
            else FixationRecordModel.model_validate(raw, from_attributes=True)
        )
    except ValidationError:
        return None
    return FixationRecord(
        intentHash=model.intentHash,
        canonical=model.canonical,
        structureHash=model.structureHash,
        pinnedSpec=model.pinnedSpec,
        fixatedAt=model.fixatedAt,
        approver=Principal(id=model.approver.id, name=model.approver.name, roles=model.approver.roles),
        catalogFingerprint=model.catalogFingerprint,
        tenant=model.tenant,
        revision=model.revision,
    )


def validate_promotion_state(raw: object) -> PromotionState | None:
    """model_validate-equivalent for PromotionState (port of TS PromotionStateSchema.safeParse).

    Same rationale and calling convention as validate_fixation_record. Callers (kohaku.lineage's
    CandidateStore.load) treat None exactly like a real absence (the candidate falls back to status
    "in_use", the same default as no persisted state at all).
    """
    try:
        model = (
            PromotionStateModel.model_validate(raw)
            if isinstance(raw, dict)
            else PromotionStateModel.model_validate(raw, from_attributes=True)
        )
    except ValidationError:
        return None
    return PromotionState(
        artifactId=model.artifactId,
        status=model.status,
        updatedAt=model.updatedAt,
        data=model.data,
        tenant=model.tenant,
    )


@runtime_checkable
class SupportsBatchPromotionStates(Protocol):
    """Optional StoragePort extension: a single read-modify-write for several PromotionStates at once (TS's
    real optional interface field `putPromotionStates?()` on packages/spec-core/src/ports.ts). Deliberately
    not declared as a member of `StoragePort` itself -- see that Protocol's `put_promotion_states` comment
    below for why forcing every implementation (including minimal test stubs) to grow it would be wrong.
    Expressed as its own `runtime_checkable` Protocol so callers can check for support with
    `isinstance(storage, SupportsBatchPromotionStates)` instead of a manual `getattr` probe. Like that old
    probe, `isinstance` against a `runtime_checkable` Protocol only checks that the named attribute is
    present, not that its signature matches -- the same presence-only semantics, just typed.
    """

    async def put_promotion_states(self, states: list[PromotionState]) -> None: ...


class StoragePort(Protocol):
    """Persistence target for cache, Lineage, and promotion state (RLS multi-tenancy etc. are the product's choice).

    Concurrency contract: StoragePort itself carries no locking or versioning. Serializing the
    read-modify-write of a given (tenant, key) is the *host's* responsibility, not the implementation's; the
    reference host_rest / host_mcp hosts do this with an in-process per-key lock (mirroring TS host-core's
    createKeyedMutex, shared by the promotion lock and the fixation lock). That lock only orders calls
    *within one process* — running multiple instances/processes against the same backing store concurrently
    (e.g. two hosts sharing one data directory) is not supported by this contract; a lost update between
    processes can still occur. The optional conditional-write parameter below (`if_present` on put_fixation)
    is an additive hook a StoragePort MAY use to narrow one specific race (a stale self-heal resurrecting a
    fixation deleted by another writer); implementations that ignore it keep unconditional (legacy) write
    behavior. A full compare-and-swap contract is out of scope for v0.1 and left to future extension.
    """

    async def get_spec_cache(self, key: str) -> UISpec | None: ...

    async def put_spec_cache(
        self, key: str, spec: UISpec, *, ttl_seconds: int | None = None
    ) -> None: ...

    async def append_lineage(self, event: LineageEventRecord) -> None: ...

    async def list_lineage(self, filter: LineageFilter | None = None) -> list[LineageEventRecord]: ...

    async def get_promotion_state(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionState | None: ...

    async def put_promotion_state(self, state: PromotionState) -> None: ...

    async def list_promotion_states(self, tenant: str | None = None) -> list[PromotionState]: ...

    # `put_promotion_states` (batch put) is a *genuinely optional* StoragePort extension -- unlike
    # `delete_fixation` above (a required method that an unsupporting implementation opts out of via
    # NotImplementedError), this one is deliberately **not** declared as a member of this Protocol. TS's
    # counterpart (packages/spec-core/src/ports.ts) is a real optional interface field
    # (`putPromotionStates?()`), checked by callers via `storage.putPromotionStates != null`; Python has no
    # equivalent "optional Protocol member" construct that would not force every existing StoragePort
    # implementation across the codebase (including minimal test stubs that intentionally implement only a
    # subset of methods) to grow a new method just to keep type-checking. Callers instead check for it at the
    # call site via `isinstance(storage, SupportsBatchPromotionStates)` (see that Protocol above -- a typed,
    # runtime_checkable equivalent of a manual `getattr(storage, "put_promotion_states", None)` probe, with
    # the same presence-only semantics), falling back to looping put_promotion_state when absent. See
    # kohaku.storage.file.FileStoragePort.put_promotion_states for the reference implementation (one
    # read-modify-write for every state in the batch).

    async def get_fixation(
        self, intent_hash: str, tenant: str | None = None
    ) -> FixationRecord | None: ...

    async def put_fixation(self, record: FixationRecord, *, if_present: bool = False) -> None:
        """Save a fixation.

        if_present (optional, additive): when True, the write MUST be a no-op unless a fixation currently
        exists at (record.tenant, record.intentHash) — used by self-healing's refresh_fingerprint so a
        get->put that races with a concurrent delete does not resurrect an already-removed fixation. An
        implementation that ignores the parameter keeps the legacy unconditional-write behavior.
        """
        ...

    async def list_fixations(self, tenant: str | None = None) -> list[FixationRecord]: ...

    async def delete_fixation(self, intent_hash: str, tenant: str | None = None) -> None:
        """Release a fixation (optional extension). An unsupported implementation raises NotImplementedError
        (fail-fast; no audit event is recorded either)."""
        ...


@dataclass(frozen=True)
class CatalogContribution:
    """Contribution of domain-specific components (a diff to the core catalog).

    The concrete ComponentDefinition is owned by kohaku.registry.
    """

    components: list[Any]


type ThemeTokens = dict[str, str | float]
"""Semantic design tokens. Defaults are owned by the renderer (this side is only the typed vocabulary)."""
