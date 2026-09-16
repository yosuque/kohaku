"""Application service for the promotion pipeline (L2 -> L1) (Port of TS promotion/service.ts).

State is dual-recorded in the StoragePort (snapshot) + Lineage events, but the "source of truth" is split by role:
- **The read source of truth is the snapshot** (get_promotion_state / list_promotion_states).
- **Lineage is the audit source of truth** (an append-only log of who / when / which version judged/approved).
publish's side effects (reflecting into the Registry / Intent catalog) are implemented by the product via on_publish.

Differences from TS:
- createPromotions's opts object becomes create_promotions's keyword arguments. judge / on_publish /
  validate_publish / on_unpublish are received as a Callable + context dataclass (corresponding to TS's object argument).
- judge's verdict is a plain dict[str, Any] (like TS's plain object, persisted into the snapshot).
- Time (persist's updatedAt) is injectable via the clock argument (default now_iso).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, cast

from kohaku.spec import (
    GovernanceErrorDiscriminators,
    LineageActor,
    LineageFilter,
    Principal,
    PromotionState,
    StoragePort,
    validate_promotion_state,
)

from ..events import Clock, now_iso
from ..lineage import Lineage
from .machine import (
    ComponentDraft,
    JudgeResult,
    JudgeStart,
    MachinePolicy,
    Nominate,
    PromotionAction,
    PromotionStatus,
    Publish,
    Review,
    ReviewApprove,
    ReviewReject,
    ReviewStart,
    SchemaPropose,
    Unpublish,
    Withdraw,
    component_draft_from_wire,
    may_have_projection,
    transition,
)


@dataclass(frozen=True)
class PromotionPolicy:
    """Thresholds for candidacy + the judge blocking policy."""

    minUses: int = 20
    minDistinctSessions: int = 5
    judgeBlocking: bool = True


DEFAULT_PROMOTION_POLICY = PromotionPolicy()


class PromotionNotPublishedError(Exception):
    """approve()'s batch transition did not reach published (it stayed at an intermediate state due to a judge failure, rejection, etc.).

    Rather than swallowing it, this is raised so the caller can detect "approved yet not published."
    """

    code = GovernanceErrorDiscriminators.NOT_PUBLISHED_CODE

    def __init__(self, artifact_id: str, status: str, verdict: Any = None) -> None:
        super().__init__(
            f'Promotion approval did not reach published (artifact {artifact_id} is in status "{status}")'
        )
        self.name = "PromotionNotPublishedError"
        self.artifactId = artifact_id
        self.status = status
        self.verdict = verdict


class PromotionNotRejectedError(Exception):
    """reject()'s batch transition did not reach rejected. Symmetric with approve() (prevents silent swallowing)."""

    code = GovernanceErrorDiscriminators.NOT_REJECTED_CODE

    def __init__(self, artifact_id: str, status: str, verdict: Any = None) -> None:
        super().__init__(
            f'Promotion rejection did not reach rejected (artifact {artifact_id} is in status "{status}")'
        )
        self.name = GovernanceErrorDiscriminators.NOT_REJECTED_NAME
        self.artifactId = artifact_id
        self.status = status
        self.verdict = verdict


class ArtifactNotFoundError(ValueError):
    """Raised when act/approve/reject/withdraw is called for an artifact that does not exist (or belongs to
    another tenant) and the host's own pre-check (PromotionsApi.get) could not run or slipped through a race.
    Carries `code` (kohaku.spec's GovernanceErrorDiscriminators.ARTIFACT_NOT_FOUND_CODE) so host_rest maps this
    to 404 by code rather than a message-text match (a wording change here would otherwise silently break a
    regex on the host side) — mirrors the TS reference implementation's candidate-store.ts `require()`.
    Subclasses ValueError (not just Exception) for backward compatibility: callers that pre-date this class
    already catch/expect a ValueError for "unknown artifact" (e.g. kohaku.lineage.test_promotion).
    """

    code = GovernanceErrorDiscriminators.ARTIFACT_NOT_FOUND_CODE

    def __init__(self, artifact_id: str) -> None:
        super().__init__(f"unknown artifact: {artifact_id}")
        self.artifactId = artifact_id


@dataclass(frozen=True)
class ReconcileSummary:
    """Summary returned by reconcile() (#11): how many published/withdrawn snapshots had their projection
    re-applied, and how many were skipped because the data needed to rebuild the projection was unrecoverable
    (reported individually via on_error({endpoint: "promotion.reconcile.projection"})). Port of TS's
    ReconcileSummary."""

    published: int = 0
    withdrawn: int = 0
    skipped: int = 0


@dataclass
class PromotionCandidate:
    """A promotion candidate (state + usage aggregation + preview material). The act path updates status/verdict/draft."""

    artifactId: str
    status: PromotionStatus
    uses: int
    sessions: int
    updatedAt: str
    canonical: str | None = None
    request: str | None = None
    html: str | None = None
    sha256: str | None = None
    ref: str | None = None
    verdict: dict[str, Any] | None = None
    draft: ComponentDraft | None = None


@dataclass(frozen=True)
class JudgeContext:
    """Propagates the tenant passed to approve into the judge (for per-tenant aggregation of telemetry, etc.)."""

    tenant: str | None = None


# The judge receives a candidate and returns pass/fail and a score ({ pass, score, reason?, rubricId?, rubricVersion? }).
# TS makes context optional, but this port always calls with 2 arguments (the judge may ignore context).
PromotionJudge = Callable[["PromotionCandidate", JudgeContext], Awaitable[dict[str, Any]]]


@dataclass(frozen=True)
class PublishContext:
    artifactId: str
    draft: ComponentDraft
    html: str
    request: str | None = None
    tenant: str | None = None


@dataclass(frozen=True)
class ValidatePublishContext:
    artifactId: str
    draft: ComponentDraft
    html: str
    tenant: str | None = None


@dataclass(frozen=True)
class UnpublishContext:
    artifactId: str
    draft: ComponentDraft
    tenant: str | None = None


PromotionErrorEndpoint = Literal[
    "promotion.publish.audit",
    "promotion.unpublish.audit",
    "promotion.reconcile.audit",
    "promotion.reconcile.projection",
    "promotion.nominate.tenant",
    "promotion.nominate.audit",
    "storage.record.invalid",
]
"""The call sites create_promotions' on_error hook may fire from, named for the observability hook:
- promotion.publish.audit / promotion.unpublish.audit: the fail-open component.published /
  component.withdrawn audit record at publish/unpublish time failed.
- promotion.reconcile.audit: reconcile's audit-event backfill (for either side) failed.
- promotion.reconcile.projection: reconcile skipped re-applying a published snapshot's projection because
  neither the snapshot itself nor component.generated could supply the required html (#9).
- promotion.nominate.tenant: evaluate_and_list (tenant unspecified) skipped auto-nominating a candidate that
  belongs to a specific tenant, to avoid persisting a tenant-neutral state for it (#10).
- promotion.nominate.audit: the fail-open component.nominated audit record (recorded after the status
  transition to candidate is already persisted) failed for one nominated candidate. Unlike publish/unpublish's
  audit, there is currently no reconcile-style backfill for a missed component.nominated event, so the audit
  trail stays incomplete for that artifact until a manual fix.
- storage.record.invalid: a promotion-state record read back from StoragePort.get_promotion_state
  (_load_candidate) failed kohaku.spec.validate_promotion_state (§4.3 A10 of the 2026-09 review — a
  corrupted or hand-edited promotions.json entry). The reader treats it exactly like a real absence (the
  candidate falls back to status "in_use", the same default as no persisted state at all); shared with
  kohaku.lineage.fixation's Fixations service, which uses the same discriminator string for the equivalent
  fixation-record check (FixationErrorEndpoint)."""


@dataclass(frozen=True)
class PromotionErrorContext:
    endpoint: PromotionErrorEndpoint
    artifactId: str
    tenant: str | None = None


OnPublish = Callable[[PublishContext], Awaitable[None]]
ValidatePublish = Callable[[ValidatePublishContext], Awaitable[None]]
OnUnpublish = Callable[[UnpublishContext], Awaitable[None]]
OnError = Callable[[PromotionErrorContext, BaseException], None]


def _notify_promotion_error(
    on_error: OnError | None, ctx: PromotionErrorContext, error: BaseException
) -> None:
    """Fires on_error fire-and-forget, swallowing any synchronous exception from the hook itself (an
    observation-only hook must never mask or replace the caller's own error/result). Deliberately local
    (not imported from a composer helper) because lineage does not depend on composer (dependency direction).
    """
    if on_error is None:
        return
    try:
        on_error(ctx, error)
    except Exception:  # noqa: BLE001,S110 — swallowed: observability must not affect control flow
        pass


def _tally_usage(used: list[Any]) -> tuple[int, int]:
    """Compute (uses, sessions) from a set of component.used events.

    The promotion-aggregation uses take compose-time recording (server-authoritative) as the source of truth.
    Telemetry-sourced ones (source:"telemetry") can be spoofed, so they are excluded from the aggregation.
    """
    counted = [e for e in used if e.payload.get("source") != "telemetry"]
    sessions = {
        s for s in (e.payload.get("sessionId") for e in counted) if isinstance(s, str)
    }
    return len(counted), max(len(sessions), 1 if len(counted) > 0 else 0)


def _usage_index_key(tenant: str | None, artifact_id: str) -> str:
    """Composite key for the per-record usage index (see `_group_used_by_artifact`) and the matching candidate
    lookups in `_gather_candidates` (port of TS's usageIndexKey, usage.ts). artifactId derives from content
    sha256 and is unique across tenants, so the same artifactId can be promoted independently by multiple
    tenants (#10). Keying by artifactId alone (the pre-#10 behavior) would merge those tenants' usage counts
    together whenever an aggregation scans without a tenant filter (tenant left unspecified); keying by
    (tenant, artifactId) instead keeps them separate. `tenant` here is always the *record's own* tenant (e.g.
    `event.tenant`), not the aggregation's requested scope.
    """
    return f"{tenant or ''}\x1f{artifact_id}"


def _group_used_by_artifact(used: list[Any]) -> dict[str, list[Any]]:
    """Group a set of component.used events by their (tenant, artifactId) composite key (see
    `_usage_index_key`), for computing usage in bulk."""
    by_artifact: dict[str, list[Any]] = {}
    for e in used:
        artifact_id = e.payload.get("artifactId")
        if not isinstance(artifact_id, str):
            continue
        by_artifact.setdefault(_usage_index_key(e.tenant, artifact_id), []).append(e)
    return by_artifact


class Promotions:
    """Public API for the promotion pipeline (list_candidates / act / approve / reject / withdraw / reconcile, etc.)."""

    def __init__(
        self,
        *,
        lineage: Lineage,
        storage: StoragePort,
        policy: PromotionPolicy | None = None,
        on_publish: OnPublish | None = None,
        validate_publish: ValidatePublish | None = None,
        on_unpublish: OnUnpublish | None = None,
        judge: PromotionJudge | None = None,
        clock: Clock = now_iso,
        on_error: OnError | None = None,
    ) -> None:
        self._lineage = lineage
        self._storage = storage
        self._on_error = on_error
        self._policy = policy if policy is not None else DEFAULT_PROMOTION_POLICY
        self._machine_policy = MachinePolicy(judgeBlocking=self._policy.judgeBlocking)
        self._on_publish = on_publish
        self._validate_publish = validate_publish
        self._on_unpublish = on_unpublish
        self._judge = judge
        self._clock = clock

    async def _usage_of(self, artifact_id: str, tenant: str | None = None) -> tuple[int, int]:
        used = await self._storage.list_lineage(
            LineageFilter(
                type=["component.used"], artifactId=artifact_id, limit=10_000, tenant=tenant
            )
        )
        return _tally_usage(used)

    def _validated_promotion_state(
        self, raw: PromotionState | None, artifact_id: str, tenant: str | None
    ) -> PromotionState | None:
        """Validates a promotion-state record read back from storage (kohaku.spec.validate_promotion_state),
        treating a validation failure exactly like a real absence: `_load_candidate`'s existing
        `state.status if state is not None else "in_use"` / `state.data.get(...)` fallbacks already do the
        right thing with `None`, so a corrupted record degrades to "no persisted state" rather than
        propagating a broken shape."""
        if raw is None:
            return None
        validated = validate_promotion_state(raw)
        if validated is not None:
            return validated
        _notify_promotion_error(
            self._on_error,
            PromotionErrorContext(endpoint="storage.record.invalid", artifactId=artifact_id, tenant=tenant),
            ValueError(f"promotion state for {artifact_id} failed schema validation"),
        )
        return None

    async def _load_candidate(
        self,
        artifact_id: str,
        usage: tuple[int, int] | None = None,
        tenant: str | None = None,
        generated_event: Any = None,
    ) -> PromotionCandidate | None:
        # Narrow the promotion state by tenant too. Even if the same artifactId exists for multiple tenants, they
        # do not get mixed. Fetched before the component.generated lookup below because a self-contained
        # published snapshot (persist's html/sha256/ref copy, #9) can make the generated lookup unnecessary.
        state = self._validated_promotion_state(
            await self._storage.get_promotion_state(artifact_id, tenant), artifact_id, tenant
        )
        if generated_event is not None:
            generated = [generated_event]
        else:
            generated = await self._storage.list_lineage(
                LineageFilter(
                    type=["component.generated"], artifactId=artifact_id, limit=1, tenant=tenant
                )
            )
        payload = generated[0].payload if len(generated) > 0 else None
        # Self-contained published projection (#9): once published, persist duplicates html/sha256/ref onto the
        # snapshot itself, so a lineage.jsonl replacement/loss no longer makes a published (or previously
        # published) component unrecoverable — prefer the snapshot's own copy, falling back to
        # component.generated otherwise.
        snapshot_html = state.data.get("html") if state is not None else None
        if payload is None and snapshot_html is None:
            return None
        if usage is None:
            usage = await self._usage_of(artifact_id, tenant)
        uses, sessions = usage
        draft_wire = state.data.get("draft") if state is not None else None
        state_data: dict[str, Any] = state.data if state is not None else {}
        payload_data: dict[str, Any] = payload if payload is not None else {}
        return PromotionCandidate(
            artifactId=artifact_id,
            status=cast("PromotionStatus", state.status) if state is not None else "in_use",
            canonical=payload_data.get("canonical"),
            request=payload_data.get("request", state_data.get("request")),
            html=snapshot_html if snapshot_html is not None else payload_data.get("html"),
            sha256=state_data.get("sha256", payload_data.get("artifactSha256")),
            ref=state_data.get("ref", payload_data.get("ref")),
            uses=uses,
            sessions=sessions,
            verdict=state_data.get("verdict"),
            draft=(
                component_draft_from_wire(draft_wire) if isinstance(draft_wire, dict) else None
            ),
            updatedAt=state.updatedAt if state is not None else generated[0].ts,
        )

    def _build_promotion_state(
        self, candidate: PromotionCandidate, tenant: str | None = None
    ) -> PromotionState:
        """Pure builder (no I/O) shared by `_persist` (one write) and `_persist_many` (a batch write, so
        several states can be built up front before issuing a single storage call)."""
        data: dict[str, Any] = {}
        if candidate.verdict is not None:
            data["verdict"] = candidate.verdict
        if candidate.draft is not None:
            data["draft"] = candidate.draft.to_wire()
        if candidate.request is not None:
            data["request"] = candidate.request
        # Self-contained published projection (#9): once the candidate reaches published, duplicate what
        # reconcile needs to rebuild the projection (html/sha256/ref/componentType) directly onto the snapshot.
        # Without this, reconcile depends on the component.generated lineage event surviving indefinitely — a
        # lineage.jsonl replacement/loss silently makes a published component vanish on the next startup
        # reconcile even though the state authority (promotions.json) still says "published". Not copied on
        # other transitions (including unpublish's own persist call, whose candidate.status is already
        # "withdrawn" by the time it runs): a withdrawn/rejected snapshot has no projection to rebuild from
        # html, and dropping it there keeps the persisted shape unchanged for every non-publish transition.
        if candidate.status == "published":
            if candidate.html is not None:
                data["html"] = candidate.html
            if candidate.sha256 is not None:
                data["sha256"] = candidate.sha256
            if candidate.ref is not None:
                data["ref"] = candidate.ref
            if candidate.draft is not None:
                data["componentType"] = candidate.draft.componentType
        return PromotionState(
            artifactId=candidate.artifactId,
            status=candidate.status,
            updatedAt=self._clock(),
            data=data,
            tenant=tenant,
        )

    async def _persist(self, candidate: PromotionCandidate, tenant: str | None = None) -> None:
        await self._storage.put_promotion_state(self._build_promotion_state(candidate, tenant))

    async def _persist_many(
        self, candidates: list[PromotionCandidate], tenant: str | None = None
    ) -> None:
        """Batch counterpart of `_persist`: builds every PromotionState up front, then issues either one
        `StoragePort.put_promotion_states` call (when the storage duck-types it in -- see
        `kohaku.spec.ports.StoragePort`'s comment on why this is not a declared Protocol member, unlike TS's
        real optional interface field) or falls back to the legacy one-`put_promotion_state`-call-per-state
        loop. A no-op for an empty list. Used by the batch nominate persistence in `_gather_candidates` below
        (mirrors TS nomination.ts's `toPersist` / candidate-store.ts's `persistMany`)."""
        if not candidates:
            return
        states = [self._build_promotion_state(c, tenant) for c in candidates]
        put_many = getattr(self._storage, "put_promotion_states", None)
        if put_many is not None:
            await put_many(states)
        else:
            for state in states:
                await self._storage.put_promotion_state(state)

    async def _gather_candidates(
        self, auto_nominate: bool, tenant: str | None = None
    ) -> list[PromotionCandidate]:
        # Aggregation covers only the most recent 1000 component.generated events. Anything beyond is dropped (a known constraint).
        generated = await self._storage.list_lineage(
            LineageFilter(type=["component.generated"], limit=1000, tenant=tenant)
        )
        # Key candidates by (tenant, artifactId) rather than artifactId alone (#10): artifactId derives from
        # content sha256 and is globally unique, so the *same* artifactId can be promoted independently by
        # multiple tenants. Keying by artifactId alone when `tenant` is left unspecified (an all-tenant scan)
        # would collapse those tenants' independent generated events (and hence candidates) into one, silently
        # mixing their state. `e.tenant` is each event's own recorded tenant (equal to `tenant` when a specific
        # tenant was requested; the record's own value otherwise).
        keys: list[str] = []
        seen: set[str] = set()
        latest_generated: dict[str, Any] = {}
        record_of: dict[str, tuple[str, str | None]] = {}  # key -> (artifact_id, tenant)
        for e in generated:
            artifact_id = e.payload.get("artifactId")
            if not isinstance(artifact_id, str):
                continue
            key = _usage_index_key(e.tenant, artifact_id)
            if key not in seen:
                seen.add(key)
                keys.append(key)
                record_of[key] = (artifact_id, e.tenant)
            prev = latest_generated.get(key)
            if prev is None or e.ts > prev.ts:
                latest_generated[key] = e

        # Avoid the N+1 of calling listLineage per candidate; fetch component.used once and group it (by the
        # same (tenant, artifactId) composite key, #10).
        all_used = await self._storage.list_lineage(
            LineageFilter(type=["component.used"], limit=10_000, tenant=tenant)
        )
        used_by_artifact = _group_used_by_artifact(all_used)

        # A guard that collects already-nominated artifacts with a single listLineage (prevents double-recording).
        # Keyed by (tenant, artifactId) composite key (#10), not artifactId alone: artifactId derives from
        # content sha256 and is globally unique, so the *same* artifactId can be independently nominated by
        # multiple tenants (mirrors this function's own (tenant, artifactId) candidate keying above, and TS
        # nomination.ts's own composite-keyed nominatedIds). Keying by artifactId alone would, on an
        # all-tenant scan (tenant left unspecified), let one tenant's prior component.nominated event
        # suppress another tenant's own eligible in_use candidate for the same artifactId — a silent no-op
        # that never transitions it to candidate.
        nominated_ids: set[str] = set()
        if auto_nominate:
            nominated_events = await self._storage.list_lineage(
                LineageFilter(type=["component.nominated"], limit=10_000, tenant=tenant)
            )
            for e in nominated_events:
                artifact_id = e.payload.get("artifactId")
                if isinstance(artifact_id, str):
                    nominated_ids.add(_usage_index_key(e.tenant, artifact_id))

        # Nominated-this-pass candidates, batch-persisted once (via _persist_many) and then audited
        # (fail-open) below — mirrors TS nomination.ts's toPersist: every eligible candidate's status
        # transition is applied in memory first, then persisted with a single storage write instead of one
        # per candidate (a scan that nominates many candidates at once, e.g. after a burst of usage, no
        # longer re-reads/re-stringifies/re-writes promotions.json once per candidate).
        to_persist: list[PromotionCandidate] = []

        candidates: list[PromotionCandidate] = []
        for key in keys:
            artifact_id, record_tenant = record_of[key]
            candidate = await self._load_candidate(
                artifact_id,
                _tally_usage(used_by_artifact.get(key, [])),
                record_tenant,
                latest_generated.get(key),
            )
            if candidate is None:
                continue
            # AUTO: on threshold satisfaction, in_use -> candidate. Already-nominated ones are not re-recorded.
            if (
                auto_nominate
                and candidate.status == "in_use"
                and _usage_index_key(record_tenant, artifact_id) not in nominated_ids
                and candidate.uses >= self._policy.minUses
                and candidate.sessions >= self._policy.minDistinctSessions
            ):
                # Tenant-mismatch guard (#10): `tenant` is the call-level scope passed to evaluate_and_list
                # (None = an all-tenant scan). When it is None but this candidate's own recorded tenant is not
                # (a tenant-tagged record surfaced by an all-tenant scan), persisting it under the tenant-neutral
                # scope would create/overwrite a tenant-neutral promotion state for an artifact that actually
                # belongs to one tenant — silently mixing single-tenant and multi-tenant governance state. Such
                # a candidate is skipped (left in_use, un-nominated) and reported via on_error instead.
                # Single-tenant operation (no record ever carries a tenant) never triggers this.
                if tenant is None and record_tenant is not None:
                    _notify_promotion_error(
                        self._on_error,
                        PromotionErrorContext(
                            endpoint="promotion.nominate.tenant",
                            artifactId=artifact_id,
                            tenant=record_tenant,
                        ),
                        ValueError(
                            f"skipped auto-nomination for artifact {artifact_id}: "
                            f'evaluate_and_list was called with no tenant scope, but this candidate belongs to tenant "{record_tenant}"'
                        ),
                    )
                    candidates.append(candidate)
                    continue
                candidate.status = transition(
                    candidate.status, Nominate(by="policy"), self._machine_policy
                )
                to_persist.append(candidate)
                nominated_ids.add(_usage_index_key(record_tenant, artifact_id))
            candidates.append(candidate)

        # Every eligible candidate's status transition is now applied in memory; persist them all in a single
        # batch write (see _persist_many's doc for the StoragePort.put_promotion_states duck-type / fallback).
        await self._persist_many(to_persist, tenant)

        # component.nominated audit events are recorded only after the batch persist above resolves, and are
        # fail-open (mirroring handle_publish's own audit record): the status transition is already durable
        # by this point, so a storage hiccup recording the audit event must not stop the batch (or leave a
        # persisted-but-unaudited candidate silently swallowed along with every candidate still queued after
        # it) — the failure is instead reported per-candidate via on_error(endpoint="promotion.nominate.audit").
        # See PromotionErrorEndpoint's doc for why this leaves that one nominate permanently unaudited (no
        # reconcile-style backfill) even though the candidate is already persisted as "candidate".
        for candidate in to_persist:
            try:
                await self._lineage.record(
                    "component.nominated",
                    {"artifactId": candidate.artifactId, "by": "policy"},
                    None,
                    tenant,
                )
            except Exception as e:  # noqa: BLE001 — fail-open; see doc above
                _notify_promotion_error(
                    self._on_error,
                    PromotionErrorContext(
                        endpoint="promotion.nominate.audit",
                        artifactId=candidate.artifactId,
                        tenant=tenant,
                    ),
                    e,
                )

        return sorted(candidates, key=lambda c: c.uses, reverse=True)

    async def list_candidates(self, *, tenant: str | None = None) -> list[PromotionCandidate]:
        """Read-only candidate list (does neither auto-nominate nor persist).

        Corresponds to TS's Promotions.list. Renamed to list_candidates to avoid clashing with the built-in
        `list` (defining a `list` method on the class would make the `list[...]` annotations of later methods
        be misread as the method, failing mypy strict) (an intentional difference).
        """
        return await self._gather_candidates(False, tenant)

    async def evaluate_and_list(self, *, tenant: str | None = None) -> list[PromotionCandidate]:
        """Make threshold-satisfying in_use into candidates (recording nominate) while returning the list."""
        return await self._gather_candidates(True, tenant)

    async def list_by_status(
        self, status: PromotionStatus, *, tenant: str | None = None
    ) -> list[PromotionCandidate]:
        """Per-status list. No side effects."""
        if status == "in_use":
            # The promotion state is not saved (before nominate), so it does not appear in listPromotionStates.
            all_candidates = await self._gather_candidates(False, tenant)
            return [c for c in all_candidates if c.status == "in_use"]
        states = await self._storage.list_promotion_states(tenant)
        all_used = await self._storage.list_lineage(
            LineageFilter(type=["component.used"], limit=10_000, tenant=tenant)
        )
        used_by_artifact = _group_used_by_artifact(all_used)
        # N+1 avoidance for component.generated too (mirrors _gather_candidates' own generated index, and
        # reconcile's): a single bulk fetch of the most recent 1000 component.generated events, keyed the same
        # way, so a state whose generated event falls inside that window skips _load_candidate's own individual
        # list_lineage lookup. A state whose generated event has aged out of the window is simply absent here
        # and falls back to that per-artifact lookup, unchanged from before.
        generated_events = await self._storage.list_lineage(
            LineageFilter(type=["component.generated"], limit=1000, tenant=tenant)
        )
        latest_generated_by_key: dict[str, Any] = {}
        for e in generated_events:
            artifact_id = e.payload.get("artifactId")
            if not isinstance(artifact_id, str):
                continue
            key = _usage_index_key(e.tenant, artifact_id)
            prev = latest_generated_by_key.get(key)
            if prev is None or e.ts > prev.ts:
                latest_generated_by_key[key] = e
        candidates: list[PromotionCandidate] = []
        for state in states:
            if state.status != status:
                continue
            # Use each state's own recorded tenant (state.tenant), not the call-level `tenant` (#10): when
            # `tenant` is left unspecified (an all-tenant scan), list_promotion_states(None) returns every
            # tenant's states mixed together, and loading a tenant-owned state with tenant=None would miss its
            # component.generated / promotion-state lookups (they are keyed by the actual owning tenant),
            # silently falling back to a wrong/incomplete candidate. When a specific tenant was requested,
            # state.tenant already equals it (list_promotion_states(tenant) filters to that tenant), so this is
            # a no-op for that case.
            key = _usage_index_key(state.tenant, state.artifactId)
            candidate = await self._load_candidate(
                state.artifactId,
                _tally_usage(used_by_artifact.get(key, [])),
                state.tenant,
                latest_generated_by_key.get(key),
            )
            # Something that has state but whose component.generated cannot be pulled (normally impossible) cannot be projected, so exclude it.
            if candidate is not None:
                candidates.append(candidate)
        return sorted(candidates, key=lambda c: c.uses, reverse=True)

    async def get(
        self, artifact_id: str, tenant: str | None = None
    ) -> PromotionCandidate | None:
        """Single fetch. When tenant is given, only candidates whose owning tenant matches (non-match is None)."""
        return await self._load_candidate(artifact_id, None, tenant)

    async def act(
        self,
        artifact_id: str,
        action: PromotionAction,
        actor: Principal,
        tenant: str | None = None,
    ) -> PromotionCandidate:
        """Execute a single transition (load -> transition -> record -> persist).

        Idempotency contract (3-13a): **act is not idempotent**. Serializing concurrent / retried calls is the caller's responsibility.
        When tenant is given, if the owning tenant does not match it is treated as "unknown artifact".
        """
        candidate = await self._load_candidate(artifact_id, None, tenant)
        if candidate is None:
            raise ArtifactNotFoundError(artifact_id)

        # Invalid transitions from a terminal state are rejected by the machine side (transition) with a TransitionError.
        candidate.status = transition(candidate.status, action, self._machine_policy)

        if isinstance(action, Nominate):
            await self._lineage.record(
                "component.nominated", {"artifactId": artifact_id, "by": actor.id}, None, tenant
            )
        elif isinstance(action, Review):
            payload: dict[str, Any] = {
                "artifactId": artifact_id,
                "decision": action.kind.replace("review.", ""),
                "reviewer": actor.id,
            }
            if action.comment is not None:
                payload["comment"] = action.comment
            await self._lineage.record(
                "component.reviewed", payload, LineageActor(kind="user", id=actor.id), tenant
            )
        elif isinstance(action, SchemaPropose):
            candidate.draft = action.draft
            await self._lineage.record(
                "component.schemaProposed",
                {"artifactId": artifact_id, "draft": action.draft.to_wire()},
                None,
                tenant,
            )
        elif isinstance(action, Publish):
            if candidate.draft is None:
                raise ValueError("publish requires a schema draft")
            if candidate.html is None:
                raise ValueError("publish requires the artifact html")
            # #8 atomicity: process in the order "check gate -> snapshot authority -> audit -> projection application".
            # 1. validate_publish (pure check gate): if it throws, abort here and the persist is not reached.
            if self._validate_publish is not None:
                await self._validate_publish(
                    ValidatePublishContext(
                        artifactId=artifact_id,
                        draft=candidate.draft,
                        html=candidate.html,
                        tenant=tenant,
                    )
                )
            # 2. Persist the snapshot (state authority) as published first.
            await self._persist(candidate, tenant)
            # 3. Audit event (component.published). This is fail-open: a failure here (storage hiccup, etc.)
            #    must not block the projection below (the whole point of publishing), so it is reported via
            #    on_error rather than raised. The snapshot is already published (step 2), so reconcile's audit
            #    backfill (below) later detects the missing component.published event and re-records it
            #    (with reconciled:True).
            try:
                await self._lineage.record(
                    "component.published",
                    {
                        "artifactId": artifact_id,
                        "componentType": candidate.draft.componentType,
                        "version": action.version,
                        "intentName": candidate.draft.intentName,
                    },
                    None,
                    tenant,
                )
            except Exception as e:  # noqa: BLE001 — fail-open, reported via on_error
                _notify_promotion_error(
                    self._on_error,
                    PromotionErrorContext(
                        endpoint="promotion.publish.audit", artifactId=artifact_id, tenant=tenant
                    ),
                    e,
                )
            # 4. Projection application (idempotent). A failure is a "not-reflected" against the snapshot authority, and reconcile converges it.
            if self._on_publish is not None:
                await self._on_publish(
                    PublishContext(
                        artifactId=artifact_id,
                        draft=candidate.draft,
                        html=candidate.html,
                        request=candidate.request,
                        tenant=tenant,
                    )
                )
            # publish already persisted above (do not run the common persist at the end twice).
            return candidate
        elif isinstance(action, Withdraw):
            withdraw_payload: dict[str, Any] = {"artifactId": artifact_id}
            if action.reason is not None:
                withdraw_payload["reason"] = action.reason
            await self._lineage.record("component.withdrawn", withdraw_payload, None, tenant)
        elif isinstance(action, Unpublish):
            # transition succeeded = the original state is confirmed to be published (the machine rejects anything but published).
            # A published record without a draft is a state inconsistency, so fail-fast.
            if candidate.draft is None:
                raise ValueError(
                    f"unpublish requires the persisted schema draft (artifact {artifact_id})"
                )
            # Order: snapshot authority -> audit -> projection removal, mirroring the Publish branch above
            # (snapshot-first, so a mid-sequence failure never leaves the snapshot inconsistent in a way that a
            # later reconcile could silently re-publish from). on_unpublish must be idempotent, because
            # reconcile re-runs it for every non-published snapshot whose candidate still has a persisted draft.
            # 1. Persist the snapshot (state authority) as withdrawn first.
            await self._persist(candidate, tenant)
            # 2. Audit event. from:"published" distinguishes this, for audit purposes, from a pre-promotion
            #    withdraw. Fail-open (#11), symmetric with the Publish branch's own audit record: a storage
            #    hiccup here must not block the projection removal below (the whole point of unpublishing). The
            #    snapshot is already withdrawn (step 1), so reconcile's audit backfill later detects the missing
            #    component.withdrawn (from:"published") event and re-records it (with reconciled:True).
            unpublish_payload: dict[str, Any] = {
                "artifactId": artifact_id,
                "from": "published",
                "by": actor.id,
            }
            if action.reason is not None:
                unpublish_payload["reason"] = action.reason
            try:
                await self._lineage.record(
                    "component.withdrawn",
                    unpublish_payload,
                    LineageActor(kind="user", id=actor.id),
                    tenant,
                )
            except Exception as e:  # noqa: BLE001 — fail-open, reported via on_error
                _notify_promotion_error(
                    self._on_error,
                    PromotionErrorContext(
                        endpoint="promotion.unpublish.audit", artifactId=artifact_id, tenant=tenant
                    ),
                    e,
                )
            # 3. Projection removal (idempotent; reconcile re-runs it against any lingering projection).
            if self._on_unpublish is not None:
                await self._on_unpublish(
                    UnpublishContext(
                        artifactId=artifact_id, draft=candidate.draft, tenant=tenant
                    )
                )
            # unpublish already persisted above (do not run the common persist at the end twice).
            return candidate
        elif isinstance(action, JudgeResult):
            candidate.verdict = action.verdict
            await self._lineage.record(
                "component.judged",
                {"artifactId": artifact_id, "verdict": action.verdict},
                None,
                tenant,
            )
        # JudgeStart / ReviewStart record nothing (state transition only).

        await self._persist(candidate, tenant)
        return candidate

    async def approve(
        self,
        artifact_id: str,
        draft: ComponentDraft,
        reviewer: Principal,
        tenant: str | None = None,
    ) -> PromotionCandidate:
        """Batch-execute the fixed transitions from candidate (or in_use / changes_requested / judge_failed) to
        published.

        Recovery from changes_requested / judge_failed: a candidate sent back by review.requestChanges, or one
        that stopped at judge_failed (a blocking judge failure), is also returned to candidate and rejoins the
        subsequent judge -> review -> approve chain (= the "fix and re-approve" flow — a fresh judge run gives
        it another chance to pass). The transition table is unchanged and the path from candidate onward is
        identical to the first approve, so LIN-PRM-001 (a human review.approve precedes publish) is preserved.

        Idempotent re-projection on an already-published candidate (#11): a retry against a candidate that is
        *already* published (loaded as such, before any of the transitions below run) previously returned
        success without re-running on_publish. If the original publish's projection application had failed
        partway (the snapshot is persisted and audited before on_publish runs — see the Publish branch of
        `act`), the caller would see a successful retry response yet the projection stayed un-reflected until
        the next reconcile. Re-running on_publish here instead converges it immediately; this is safe because
        on_publish must already be idempotent (the same contract `reconcile` relies on).
        """
        candidate = await self._load_candidate(artifact_id, None, tenant)
        if candidate is None:
            raise ArtifactNotFoundError(artifact_id)
        if candidate.status == "published":
            if self._on_publish is not None and candidate.draft is not None and candidate.html is not None:
                await self._on_publish(
                    PublishContext(
                        artifactId=artifact_id,
                        draft=candidate.draft,
                        html=candidate.html,
                        request=candidate.request,
                        tenant=tenant,
                    )
                )
            return candidate
        # in_use (not yet nominated), changes_requested (sent back for changes), and judge_failed (a blocking
        # judge failure) all go (back) to candidate via nominate.
        if candidate.status in ("in_use", "changes_requested", "judge_failed"):
            candidate = await self.act(artifact_id, Nominate(by=reviewer), reviewer, tenant)
        if candidate.status == "candidate":
            candidate = await self.act(artifact_id, JudgeStart(), reviewer, tenant)
            # judge unset (no review hook) is treated as a pass with no advice -> straight to human review.
            verdict: dict[str, Any] = {"pass": True, "score": 0}
            if self._judge is not None:
                try:
                    verdict = await self._judge(
                        candidate, JudgeContext(tenant=tenant)
                    )
                except Exception as e:
                    # A judge that cannot run (LLM trouble, etc.) does not fail-open but falls to "cannot decide = fail".
                    # Whether promotion is allowed is delegated to the machine's judgeBlocking policy. Keep the reason in the verdict.
                    verdict = {
                        "pass": False,
                        "score": 0,
                        "reason": f"judge could not run: {e}",
                    }
            candidate = await self.act(artifact_id, JudgeResult(verdict=verdict), reviewer, tenant)
        if candidate.status == "in_review":
            candidate = await self.act(
                artifact_id,
                ReviewApprove(reviewer=reviewer, comment="approved via promotions.approve"),
                reviewer,
                tenant,
            )
        if candidate.status == "approved":
            candidate = await self.act(artifact_id, SchemaPropose(draft=draft), reviewer, tenant)
        if candidate.status == "schema_proposed":
            candidate = await self.act(
                artifact_id, Publish(version=draft.version), reviewer, tenant
            )
        # If the batch transition did not advance to published, raise the "approved yet not published" inconsistency rather than swallowing it.
        # A re-approve of an already-published entry enters none of the ifs and stays published, so it returns idempotently without raising.
        if candidate.status != "published":
            raise PromotionNotPublishedError(artifact_id, candidate.status, candidate.verdict)
        return candidate

    async def reject(
        self, artifact_id: str, reviewer: Principal, tenant: str | None = None
    ) -> PromotionCandidate:
        """Batch-execute the fixed transitions from candidate (or in_use) to rejected."""
        candidate = await self._load_candidate(artifact_id, None, tenant)
        if candidate is None:
            raise ArtifactNotFoundError(artifact_id)
        if candidate.status == "in_use":
            candidate = await self.act(artifact_id, Nominate(by=reviewer), reviewer, tenant)
        if candidate.status == "candidate":
            candidate = await self.act(artifact_id, ReviewStart(), reviewer, tenant)
        if candidate.status == "in_review":
            candidate = await self.act(
                artifact_id, ReviewReject(reviewer=reviewer), reviewer, tenant
            )
        # If the batch transition did not advance to rejected, raise rather than swallowing, same as approve().
        # A re-reject of an already-rejected entry enters none of the ifs and stays rejected, so it returns idempotently without raising.
        if candidate.status != "rejected":
            raise PromotionNotRejectedError(artifact_id, candidate.status, candidate.verdict)
        return candidate

    async def withdraw(
        self,
        artifact_id: str,
        actor: Principal,
        reason: str | None = None,
        tenant: str | None = None,
    ) -> PromotionCandidate:
        """Withdrawal. Routes published to unpublish and any other non-terminal to withdraw.

        A withdraw against a terminal (rejected/withdrawn) makes the machine throw TransitionError, which propagates.
        """
        candidate = await self._load_candidate(artifact_id, None, tenant)
        if candidate is None:
            raise ArtifactNotFoundError(artifact_id)
        action: PromotionAction = (
            Unpublish(reason=reason)
            if candidate.status == "published"
            else Withdraw(reason=reason)
        )
        return await self.act(artifact_id, action, actor, tenant)

    async def reconcile(self) -> ReconcileSummary:
        """Projection recovery from snapshot authority. Scans the published/withdrawn snapshots across all
        tenants — every other status has no projection to converge, see `may_have_projection` — assembles each
        artifact's complete candidate — since #9, candidate.html (and sha256/ref) come from the snapshot's own
        duplicated copy when present, falling back to component.generated for older snapshots persisted before
        this change — and idempotently re-applies on_publish. Callable at any time (not just at startup), e.g.
        host_rest's POST /promotions/reconcile (an operator escape hatch, #11).

        Symmetrically, re-applies on_unpublish for every withdrawn snapshot whose candidate still has a
        persisted draft, converging a withdrawal whose projection removal failed partway (the snapshot
        transitioned to withdrawn, but the catalog/Intent entry was never removed). on_unpublish must likewise
        be idempotent.

        Race with a concurrent transition: the scan (list_promotion_states) and each candidate's
        _load_candidate are two separate reads with no lock held across them (host_rest's POST
        /promotions/reconcile route only takes the tenant-neutral lock bucket, so a tenant-scoped
        approve/withdraw can run between the two). _load_candidate always re-reads get_promotion_state, so
        right after it returns, the candidate's status is already the freshest value on hand — trusting it is
        all the fix takes. Both branches below re-check that status immediately after the load and skip
        (uncounted, without on_error; this is a stale scan entry, not an unrecoverable failure) when it no
        longer matches what the scan expected: the published branch will not re-publish a projection for a
        candidate that has since been withdrawn, and the withdrawn branch will not unpublish one that has since
        been re-published. The other branch's own pass (this reconcile or the next) converges the skipped entry
        instead. Serializing the whole scan+load sequence against every per-tenant lock bucket (two-phase
        locking) would close this window entirely; that is a structural follow-up, not implemented here.

        Also backfills the audit event for either direction: publish's component.published record and
        unpublish's component.withdrawn record are both fail-open (see the Publish / Unpublish branches of
        `act` above), so a storage hiccup there can leave a published/withdrawn snapshot with no matching audit
        event on the log. For every published snapshot with a persisted draft, reconcile checks for an existing
        component.published event (by artifactId + tenant) and, if none is found, records one with
        reconciled:True as the audit marker; symmetrically for a withdrawn snapshot and component.withdrawn
        (matched by from:"published", so a pre-promotion withdraw's own withdrawn event does not satisfy this
        check). A second reconcile finds the backfilled event and does not duplicate it.

        Returns a summary (ReconcileSummary, #11) of how many published/withdrawn projections were re-applied
        and how many snapshots were skipped because the data needed to rebuild the projection was unrecoverable
        (reported individually via on_error({endpoint: "promotion.reconcile.projection"})). The race-driven
        skips described above are deliberately not counted here (they are not failures).

        N+1 avoidance: before the loop, this builds the same kind of bulk indexes _gather_candidates already
        builds once instead of once per candidate -- a usage index, the latest component.generated per
        (tenant, artifactId) (fed into _load_candidate as generated_event, falling back to its own per-artifact
        lookup for anything outside the window), and an existing-audit-record index for both
        component.published and component.withdrawn(from:"published") (so the per-candidate backfill check
        below is a set lookup rather than its own list_lineage round trip).
        """
        summary = ReconcileSummary()
        if self._on_publish is None and self._on_unpublish is None:
            return summary
        published_count = 0
        withdrawn_count = 0
        skipped_count = 0
        states = await self._storage.list_promotion_states()
        used_by_artifact = _group_used_by_artifact(
            await self._storage.list_lineage(LineageFilter(type=["component.used"], limit=10_000))
        )
        generated_events = await self._storage.list_lineage(
            LineageFilter(type=["component.generated"], limit=1000)
        )
        latest_generated_by_key: dict[str, Any] = {}
        for e in generated_events:
            artifact_id = e.payload.get("artifactId")
            if not isinstance(artifact_id, str):
                continue
            key = _usage_index_key(e.tenant, artifact_id)
            prev = latest_generated_by_key.get(key)
            if prev is None or e.ts > prev.ts:
                latest_generated_by_key[key] = e
        published_audit_keys = {
            _usage_index_key(e.tenant, e.payload["artifactId"])
            for e in await self._storage.list_lineage(
                LineageFilter(type=["component.published"], limit=10_000)
            )
            if isinstance(e.payload.get("artifactId"), str)
        }
        withdrawn_from_published_audit_keys = {
            _usage_index_key(e.tenant, e.payload["artifactId"])
            for e in await self._storage.list_lineage(
                LineageFilter(type=["component.withdrawn"], limit=10_000)
            )
            if e.payload.get("from") == "published" and isinstance(e.payload.get("artifactId"), str)
        }
        for state in states:
            # Only published/withdrawn snapshots can have a projection to converge (see may_have_projection's
            # doc). state.status is PromotionState's storage-layer `str` (loosely typed at the StoragePort
            # boundary); cast the same way _load_candidate already does for this field.
            if not may_have_projection(cast("PromotionStatus", state.status)):
                continue
            key = _usage_index_key(state.tenant, state.artifactId)
            usage_stats = _tally_usage(used_by_artifact.get(key, []))
            generated_event = latest_generated_by_key.get(key)
            if state.status == "published":
                candidate = await self._load_candidate(
                    state.artifactId, usage_stats, state.tenant, generated_event
                )
                # Re-check the freshest status right after the load (see this method's own doc on the
                # scan/load race): a *real* candidate whose status has since moved off "published" is a stale
                # scan entry, not a failure, so skip it uncounted and without on_error -- the withdrawn branch
                # converges it (this reconcile or the next). candidate is None is a different, pre-existing
                # case (_load_candidate found no source data at all) and falls through unchanged to the
                # "unrecoverable" skip+on_error path below.
                if candidate is not None and candidate.status != "published":
                    continue
                if candidate is not None and candidate.draft is not None and key not in published_audit_keys:
                    try:
                        await self._lineage.record(
                            "component.published",
                            {
                                "artifactId": state.artifactId,
                                "componentType": candidate.draft.componentType,
                                "version": candidate.draft.version,
                                "intentName": candidate.draft.intentName,
                                "reconciled": True,
                            },
                            None,
                            state.tenant,
                        )
                    except Exception as e:  # noqa: BLE001 — fail-open, reported via on_error
                        _notify_promotion_error(
                            self._on_error,
                            PromotionErrorContext(
                                endpoint="promotion.reconcile.audit",
                                artifactId=state.artifactId,
                                tenant=state.tenant,
                            ),
                            e,
                        )
                if self._on_publish is None:
                    continue
                # The projection cannot be reconstructed unless both draft (state, or the snapshot's own
                # duplicate) and html (snapshot duplicate or component.generated) are present. Anything
                # unrecoverable due to a missing audit log etc. is skipped (the snapshot remains, so it is
                # retried on the next reconcile) and reported.
                if candidate is None or candidate.draft is None or candidate.html is None:
                    skipped_count += 1
                    reason = (
                        "no schema draft is recorded"
                        if candidate is None or candidate.draft is None
                        else "no html is recorded (neither the snapshot nor component.generated has it)"
                    )
                    _notify_promotion_error(
                        self._on_error,
                        PromotionErrorContext(
                            endpoint="promotion.reconcile.projection",
                            artifactId=state.artifactId,
                            tenant=state.tenant,
                        ),
                        ValueError(
                            f"cannot rebuild the published projection for artifact {state.artifactId}: {reason}"
                        ),
                    )
                    continue
                await self._on_publish(
                    PublishContext(
                        artifactId=state.artifactId,
                        draft=candidate.draft,
                        html=candidate.html,
                        request=candidate.request,
                        tenant=state.tenant,
                    )
                )
                published_count += 1
                continue
            # may_have_projection admits only "published" (handled above) and "withdrawn", so only withdrawn
            # reaches here: re-apply the projection removal for a withdrawal whose on_unpublish failed partway.
            if self._on_unpublish is None:
                continue
            candidate = await self._load_candidate(
                state.artifactId, usage_stats, state.tenant, generated_event
            )
            # Re-check the freshest status for the same race as the published branch above (see this method's
            # own doc): a *real* candidate that has since been re-published is a stale scan entry, not a
            # failure, so it is skipped uncounted and without on_error rather than incorrectly unpublished --
            # the published branch converges it instead (candidate is None is the pre-existing "no source data"
            # case and falls through the same way). A candidate with no persisted draft was never published (or
            # its draft is unrecoverable), so there is no projection to remove and it is likewise skipped.
            if candidate is not None and candidate.status != "withdrawn":
                continue
            if candidate is None or candidate.draft is None:
                continue
            # Backfill component.withdrawn for a withdrawn snapshot, symmetric with the published side above:
            # matched by from:"published" so a pre-promotion withdraw's own (unrelated) withdrawn event does not
            # suppress this backfill.
            if key not in withdrawn_from_published_audit_keys:
                try:
                    await self._lineage.record(
                        "component.withdrawn",
                        {"artifactId": state.artifactId, "from": "published", "reconciled": True},
                        None,
                        state.tenant,
                    )
                except Exception as e:  # noqa: BLE001 — fail-open, reported via on_error
                    _notify_promotion_error(
                        self._on_error,
                        PromotionErrorContext(
                            endpoint="promotion.reconcile.audit",
                            artifactId=state.artifactId,
                            tenant=state.tenant,
                        ),
                        e,
                    )
            await self._on_unpublish(
                UnpublishContext(
                    artifactId=state.artifactId, draft=candidate.draft, tenant=state.tenant
                )
            )
            withdrawn_count += 1
        return ReconcileSummary(published=published_count, withdrawn=withdrawn_count, skipped=skipped_count)


def create_promotions(
    *,
    lineage: Lineage,
    storage: StoragePort,
    policy: PromotionPolicy | None = None,
    on_publish: OnPublish | None = None,
    validate_publish: ValidatePublish | None = None,
    on_unpublish: OnUnpublish | None = None,
    judge: PromotionJudge | None = None,
    clock: Clock | None = None,
    on_error: OnError | None = None,
) -> Promotions:
    return Promotions(
        lineage=lineage,
        storage=storage,
        policy=policy,
        on_publish=on_publish,
        validate_publish=validate_publish,
        on_unpublish=on_unpublish,
        judge=judge,
        clock=clock if clock is not None else now_iso,
        on_error=on_error,
    )
