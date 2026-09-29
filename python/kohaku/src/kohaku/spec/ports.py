"""The Ports the framework defines and the product implements (port of TS ports.ts).

TS interfaces are expressed as typing.Protocol (structural subtyping). Method names use Python's snake_case
convention (they are an API the product implements, not a wire contract). Record types are dataclasses.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import ValidationError

from .action_params import ActionTier
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
    """JSON Schema (doubles as the semantic-layer document in the LLM prompt). When reachable as a write
    action, validated at attach time against kohaku's own JSON Schema subset (design.md #62;
    `kohaku.spec.action_params.assert_valid_action_params_schema`) and per invoke against the actual
    payload (`validate_action_params`) before `DomainPort.invoke` ever runs."""
    resultShape: DataShape | None = None
    tier: ActionTier | None = None
    """Governance tier for invoking this action (design.md #62/#63). None is equivalent to "auto" (no
    confirm/approval gate -- the pre-existing, ungated invoke behavior)."""
    confirmMessage: str | None = None
    """Human-readable message a "confirm"-tier gate should show the user before setting
    `confirmed: true`. Ignored for other tiers."""


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


class SupportsValidateIntent(Protocol):
    """Optional `SemanticPort` extension (port of TS spec-core's `SemanticPort.validateIntent?`). Validates and
    normalizes a directly-specified Intent (the `kind: "intent"` path of `kohaku.host_core.intent.resolve_intent`).
    Unlike `normalize`, which derives an Intent from NL/GUI input, this path lets a caller hand over an
    already-structured Intent, which by construction never passes through `normalize` (or whatever Intent-catalog
    lookup a `normalize` implementation may consult internally) -- so an unknown canonical or an invalid/unknown
    param can otherwise reach `finalize_intent` unchecked, minting a fresh intentHash for a request that can
    never resolve. Implementing this closes that gap: reject such a request by raising `IntentValidationError`
    (`kohaku.spec.errors`; `message` and every issue's `message` must be safe to show a client, since REST/MCP
    surface them as-is). On success, return the normalized IntentInput (e.g. with schema defaults filled in)
    that the caller hashes and finalizes instead of the one it was given.

    Deliberately **not** declared as a member of `SemanticPort` itself: unlike TS's real optional interface
    field (`validateIntent?()`), `typing.Protocol` cannot express an optional method, and adding a required one
    would force every existing `SemanticPort` implementation (including minimal test stubs) to grow it just to
    keep type-checking. Callers instead check for it at the call site with
    `getattr(semantic, "validate_intent", None)` (see `kohaku.host_core.intent.resolve_intent`) rather than
    `isinstance` against this Protocol -- a plain presence probe is enough here (unlike
    `SupportsBatchPromotionStates` above, whose narrower `isinstance` semantics matter because `StoragePort`
    adapters are real production classes that might expose the batch method dynamically via a proxy; a
    `SemanticPort` handed to `resolve_intent` in tests is commonly an ad hoc stub object, where the plain
    `getattr` probe is the simpler and sufficient check). A `SemanticPort` that omits `validate_intent` keeps
    the historical behavior of finalizing the caller-supplied Intent unchecked (backward compatible).
    """

    async def validate_intent(self, intent: IntentInput, ctx: SessionContext) -> IntentInput: ...


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


DEFAULT_APPROVAL_TTL_SECONDS: int = 300
"""Default lifetime (seconds) of an approval token when the issuer is given no explicit TTL
(design.md #63). Deliberately much shorter than host_core's DEFAULT_CAPABILITY_TTL_SECONDS: an approval
token authorizes one specific human decision about one specific payload, not a session's worth of reads.
Port of TS ports.ts's DEFAULT_APPROVAL_TTL_SECONDS."""


@dataclass(frozen=True)
class ApprovalGrant:
    """The claims a stateless bound approval token carries (design.md #63). Port of TS ports.ts's
    ApprovalGrant. An `ApprovalPort.verify_approval` that accepts a token MUST have checked every one of
    these against the request it was presented for before returning `ok=True` -- this is what a caller
    receives back on success, not what it inspects itself."""

    action: str
    payloadHash: str
    approverId: str
    """The principal id of whoever approved. MUST differ from requesterId (design.md #63)."""
    requesterId: str
    """The principal id of whoever will invoke (or already attempted to invoke) the action."""
    exp: int
    """Expiry, epoch seconds."""
    jti: str
    """Unique id for this grant, consumed by an ApprovalStore when single-use enforcement is configured."""
    tenant: str | None = None


@dataclass(frozen=True)
class ApprovalVerifyResult:
    ok: bool
    grant: ApprovalGrant | None = None
    reason: str | None = None


class ApprovalPort(Protocol):
    """Issuance and verification of stateless, short-lived approval tokens for "approve"-tier actions
    (design.md #63). Structurally parallel to AuthzPort, but a distinct port: an approval authorizes one
    human decision about one exact payload, not a read/write scope over a Spec's lifetime, and a concrete
    token format MUST NOT be interchangeable with a capability token. Port of TS ports.ts's ApprovalPort.
    """

    async def issue_approval(
        self,
        *,
        action: str,
        payload_hash: str,
        requester_id: str,
        approver_id: str,
        tenant: str | None = None,
        ttl_seconds: int | None = None,
    ) -> str:
        """Issue a token bound to (action, payload_hash, requester_id, tenant). approver_id MUST differ
        from requester_id -- an implementation MUST reject issuing a self-approval (design.md #63) rather
        than leave that check to the caller. Default TTL DEFAULT_APPROVAL_TTL_SECONDS."""
        ...

    async def verify_approval(
        self, token: str, *, action: str, payload_hash: str, requester_id: str, tenant: str | None = None
    ) -> ApprovalVerifyResult:
        """Verify `token` against the exact (action, payload_hash, requester_id, tenant) it is presented
        for. A denial (expired, malformed, wrong binding, already consumed) is a normal outcome and MUST
        be reported as `ok=False`, never raised. MUST raise only on an infrastructure failure it cannot
        itself classify as allow/deny (e.g. an ApprovalStore outage) -- such a raised call is fail-closed:
        the caller MUST treat it as a denial."""
        ...


class ApprovalStore(Protocol):
    """Optional persistence for single-use enforcement of approval tokens. Port of TS ports.ts's
    ApprovalStore. When an ApprovalPort is configured with one, verify_approval MUST call `consume`
    exactly once per verification attempt and deny (`ok=False`) when it returns False (already consumed)
    or raises (store failure -- fail-closed). An ApprovalPort given no store keeps a token usable
    repeatedly until it expires."""

    async def consume(self, jti: str, expires_at: int) -> bool:
        """Atomically mark `jti` as consumed until `expires_at` (epoch seconds) if it was not already;
        return True on first consumption, False if `jti` was already consumed (a replay attempt)."""
        ...


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
    correlationId: str | None = None
    """Filter by the `correlationId` payload field (exact equality; port of TS ports.ts's
    LineageFilter.correlationId, design.md #53). The `view.*` / `action.*` records the REST and MCP hosts
    write carry the correlation id of the request that produced them, so one request's events can be pulled
    together; a product's own instrumentation may stamp the same field with an application-defined
    identifier. Rows stored before 0.4.0 have none and never match."""
    since: str | None = None
    """Only events at or after this time (ts >= since, inclusive). Assumes canonical ISO8601 form."""
    until: str | None = None
    """At or before this time (ts <= until, inclusive). Applied before the limit tail slice."""
    limit: int | None = None
    tenant: str | None = None
    """When set, only events whose tenant matches. Legacy events without a recorded tenant appear only under an unset filter."""


@dataclass(frozen=True)
class LineagePageRequest:
    """Forward (append-order) page request over lineage (port of TS ports.ts's LineagePageRequest,
    design.md #53). Every LineageFilter predicate applies except `limit` (`page_size` takes its place).
    See `StoragePort`'s doc comment on `page_lineage` for the paging contract itself."""

    type: list[str] | None = None
    artifactId: str | None = None
    specHash: str | None = None
    intentHash: str | None = None
    correlationId: str | None = None
    since: str | None = None
    until: str | None = None
    tenant: str | None = None
    cursor: str | None = None
    """Opaque cursor from a previous page's `LineagePage.nextCursor`. None = start from the beginning."""
    pageSize: int | None = None
    """Requested page size. Default DEFAULT_LINEAGE_PAGE_SIZE; clamped to MAX_LINEAGE_PAGE_SIZE."""


@dataclass(frozen=True)
class LineagePage:
    """One page returned by StoragePort's optional `page_lineage` (port of TS ports.ts's LineagePage)."""

    events: list[LineageEventRecord]
    """In append order (oldest first within the page), matching the request's filters."""
    nextCursor: str | None = None
    """Opaque cursor for the next page. None on the last page (nothing further to read). A page may hold
    fewer than `pageSize` events, even none, and still carry a `nextCursor` (an adapter bounds the work of
    one call); a caller keeps following `nextCursor` until it is None, whatever the page holds."""


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
    `isinstance(storage, SupportsBatchPromotionStates)` instead of a manual `getattr` probe. This is
    **narrower** than that old probe, not just a typed version of it -- verified on CPython 3.14, matching
    the documented behaviour of `runtime_checkable` since CPython 3.12: `isinstance` against a
    `runtime_checkable` Protocol resolves each member via `inspect.getattr_static`, which does **not**
    invoke `__getattr__` or descriptors, so a storage that only *dynamically* exposes
    `put_promotion_states` (a tracing/instrumentation proxy built on `__getattr__`, or a bare `Mock`/
    `AsyncMock`) passes the old `getattr(storage, "put_promotion_states", None)` probe but fails
    `isinstance` here. It also excludes a `None`-valued class attribute of that name (the old `getattr`
    probe would too, since its default is also `None`, so that one case does agree). Net effect: this
    detection is deliberately narrower than TS's `storage.putPromotionStates != null` -- a `__getattr__`
    based or mocked StoragePort that TS would treat as supporting the batch path falls back to the
    per-state loop here instead. See `python/kohaku/tests/spec/test_ports.py` for tests pinning each case.
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

    # `page_lineage` (forward, append-order paging; design.md #53) is a *genuinely optional* StoragePort
    # extension, like `put_promotion_states` above -- and for the same reason, deliberately **not** declared
    # as a member of this Protocol. TS's counterpart (packages/spec-core/src/ports.ts) is a real optional
    # interface field (`pageLineage?()`); Python has no equivalent construct that would not force every
    # existing StoragePort implementation (including minimal test stubs) to grow a new method. Unlike
    # `put_promotion_states`, callers check for this one with a plain `hasattr(storage, "page_lineage")`
    # probe rather than `isinstance` against a dedicated `runtime_checkable` Protocol -- there is no
    # equivalent narrowing concern here (page_lineage is never silently "fallen back" to a slower path the
    # way an absent batch write is; its absence instead surfaces as 501 NOT_IMPLEMENTED to the REST caller,
    # so a `__getattr__`-based proxy or `Mock` matching `hasattr` when a real implementation would not is an
    # accepted, harmless gap here). See kohaku.storage.file.FileStoragePort.page_lineage for the reference
    # implementation and kohaku.spec.lineage_page for the shared cursor codec.
    #
    # async def page_lineage(self, req: LineagePageRequest) -> LineagePage: ...

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
    # call site via `isinstance(storage, SupportsBatchPromotionStates)` (see that Protocol above -- a typed
    # check, but a **narrower** one than the old `getattr(storage, "put_promotion_states", None)` probe:
    # `isinstance` against a `runtime_checkable` Protocol resolves via `inspect.getattr_static`, so it does
    # not see a `__getattr__`-based dynamic attribute or a `Mock`/`AsyncMock`, and it excludes a
    # `None`-valued attribute of that name -- deliberately narrower than TS's
    # `storage.putPromotionStates != null`), falling back to looping put_promotion_state when absent. See
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
class RateLimitRule:
    """A token-bucket rate-limit rule: `capacity` tokens, refilled continuously at `refill_per_second`.
    Structurally identical to the Policy-as-Code file's `rateLimits` section shape
    (kohaku.spec.policy.PolicyRateLimitRule), kept as an independent type here rather than imported
    from it: this module is the framework-boundary contract and should not depend on any one schema
    representation of the same shape. Port of TS ports.ts's RateLimitRule."""

    capacity: int
    refillPerSecond: float


@dataclass(frozen=True)
class RateLimitResult:
    """Outcome of `RateLimitStore.take`. Port of TS ports.ts's RateLimitResult."""

    allow: bool
    retryAfterMs: float | None = None
    """Suggested backoff before retrying, in milliseconds (SPEC §6.1, REST-RL-001). Present only when
    allow is False."""


class RateLimitStore(Protocol):
    """A token-bucket rate-limit store, keyed by an opaque caller-supplied string (host_core's
    create_rate_limiter composes it as "tenant:principal:routeClass" — see that function's own doc). A
    Port reference implementation (host_core's create_memory_rate_limit_store, the in-process default)
    and future backing-store adapters all implement this same shape. Port of TS ports.ts's
    RateLimitStore.

    Concurrency contract: like StoragePort, this carries no cross-process locking of its own — a
    distributed backing store is expected to implement `take` atomically on its own side, not rely on
    the caller to serialize it.
    """

    async def take(self, key: str, cost: int, rule: RateLimitRule, now_ms: float) -> RateLimitResult:
        """Attempts to consume `cost` tokens from the bucket identified by `key`, under `rule`. `now_ms`
        is the caller-supplied wall-clock time (epoch milliseconds) — the store never reads the clock
        itself, keeping `take` a pure/deterministic function of its arguments, so a caller can inject a
        fixed clock in tests.

        On denial, `retryAfterMs` estimates the wait until enough tokens will have refilled for this
        same request to succeed."""
        ...


@dataclass(frozen=True)
class CatalogContribution:
    """Contribution of domain-specific components (a diff to the core catalog).

    The concrete ComponentDefinition is owned by kohaku.registry.
    """

    components: list[Any]


type ThemeTokens = dict[str, str | float]
"""Semantic design tokens. Defaults are owned by the renderer (this side is only the typed vocabulary)."""
