"""Wiring of the sample API (equivalent to apps/sample-api/src/app.ts — the heart where all packages converge).

Assembles the 4 Port implementations + core catalog (+) contributions (+) promotions (per-tenant, mutable) +
composer + host-rest + the promotion pipeline / fixation into a single FastAPI app.

Promotion (publish) is separated per tenant: tenant A's approval is reflected only in A's catalog / Intents,
and at compose time the catalog of session.tenant is resolved. The promotion-state snapshot (promotions.json) is
the sole state authority, and startup reconcile rebuilds its projection (the registry's per-tenant catalogs)
from the snapshot. Therefore create_app is async.

The authorization of the governance/audit plane is wired symmetrically with app.ts: auth (role resolution) +
authorize_governance (declarative RBAC). No header (the default) is treated as admin, preserving the legacy
unauthenticated demo behavior.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kohaku.composer import (
    ComposeContext,
    ComposeErrorContext,
    ComposeObserver,
    ComposePolicy,
    create_l2_js_sidecar,
    default_generator_version,
)
from kohaku.evals import JudgeInput, JudgeUsage, Telemetry, create_judge
from kohaku.host_rest import (
    GovernancePolicy,
    KohakuHostDeps,
    attach_kohaku_routes,
    create_governance_policy,
)
from kohaku.host_rest.deps import ActionEffects, AnalyticsWindow
from kohaku.lineage import (
    FixationErrorContext,
    FixationPolicy,
    JudgeContext,
    Lineage,
    PromotionCandidate,
    PromotionErrorContext,
    PromotionPolicy,
    PublishContext,
    SummarizeLineageOptions,
    UnpublishContext,
    ValidatePublishContext,
    create_fixations,
    create_lineage,
    create_promotions,
    create_view_recorder,
    now_iso,
    summarize_lineage,
)
from kohaku.lineage import Fixations as FixationsApi
from kohaku.llm import LlmPort
from kohaku.registry import Catalog, ResolvedCatalog, core_catalog, resolve_catalog
from kohaku.spec import (
    AuthzPort,
    FixationRecord,
    InvocationContext,
    JsonObject,
    LineageEventRecord,
    LineageFilter,
    OperationDescriptor,
    Principal,
    SessionContext,
    StoragePort,
)

from .action_effects import sales_action_effects
from .catalog import sales_contribution
from .design_system import SALES_DESIGN_SYSTEM
from .domain import OPERATIONS, QueryArgs, SalesRepo, default_seed_dir, shape_of
from .fewshot import create_fixation_fewshot
from .fixed_specs import create_fixed_specs, language_of
from .intents_catalog import IntentCatalog
from .promoted import PromotedEntry, promoted_component
from .promoted_registry import PromotedRegistry, to_promoted_entry
from .semantic_port import create_semantic_port

if TYPE_CHECKING:
    # starlette is the "rest" extra. The Request annotations of the auth / tenant hooks are stringified (from __future__),
    # so it is not imported at runtime (a design that does not require fastapi/starlette until attach_kohaku_routes is called).
    from starlette.requests import Request

_logger = logging.getLogger(__name__)


# Declarative RBAC for the governance/audit plane (SPEC §6.1 "Authorization of the governance plane" [Draft]).
# Identical in content to app.ts's createGovernancePolicy: admin=all permissions / reviewer=promotion review +
# Lineage/usage-analytics read / viewer=read only. Unknown roles and out-of-scope permissions are denied
# (deny-by-default). Role resolution is handled by _demo_auth.
_GOVERNANCE_POLICY = GovernancePolicy(
    roles={
        "admin": ["*"],
        "reviewer": ["promotion.*", "lineage.read", "analytics.read"],
        "viewer": [
            "lineage.read",
            "analytics.read",
            "promotion.list",
            "promotion.get",
            "fixation.list",
            "fixation.proposals",
        ],
    }
)


def _demo_auth(request: Request) -> Principal:
    """Principal resolution (a product responsibility). In production, principal and roles are resolved from an
    authentication platform (JWT/OIDC, etc.).

    The demo substitutes the x-kohaku-role header, and no header (the default) is treated as admin (so as not to break
    the unauthenticated behavior of existing demos and existing tests; the legacy behavior where anyone passes the
    governance plane is reproduced with the admin role).
    """
    role = request.headers.get("x-kohaku-role") or "admin"
    return Principal(id=f"demo-{role}", roles=[role])


def _demo_tenant(request: Request) -> str | None:
    """Tenant resolution (a product responsibility). The demo looks at the x-kohaku-tenant header."""
    return request.headers.get("x-kohaku-tenant") or None


class SalesDomainPort:
    """DomainPort: 5 sales-aggregation operations (= query://sales/{op}) + 1 demo write operation (annotate)."""

    def __init__(self, repo: SalesRepo) -> None:
        self._repo = repo

    async def list_operations(self) -> list[OperationDescriptor]:
        # annotate is special-cased in invoke() below rather than OPERATIONS (it is a write, not a query://
        # read), but it must still be listed here: hosts restrict capability write scopes to the action names
        # list_operations() enumerates, dropping any action.invoke the composed UI declares that is not listed.
        return [
            OperationDescriptor(
                name=name,
                description=f"sales {name} query",
                resultShape=shape_of(name, {}),
            )
            for name in OPERATIONS
        ] + [
            OperationDescriptor(
                name="annotate",
                description="sales annotate (write): appends a review note and advances the data version",
            )
        ]

    async def invoke(self, op: str, args: JsonObject, ctx: InvocationContext) -> object:
        # Demo of the direct write path (/binding/action): adds a note and advances the data version.
        if op == "annotate":
            note = args.get("note")
            note_str = note if isinstance(note, str) else ""
            return {
                "ok": True,
                "note": note_str,
                "dataVersion": self._repo.annotate(note_str),
                "notes": len(self._repo.notes),
            }
        operation = OPERATIONS.get(op)
        if operation is None:
            raise ValueError(f"unknown operation: {op}")
        query_args: QueryArgs = dict(args)
        return operation(self._repo, query_args)


@dataclass(frozen=True)
class SalesApp:
    app: Any
    """FastAPI app (with kohaku routes attached)"""
    repo: SalesRepo
    compose_ctx: ComposeContext
    deps: KohakuHostDeps
    domain: SalesDomainPort
    # View Lineage (the record destination for promotion, fixation, and audit). Exposed so the MCP side (mcp_main)
    # can share the same lineage, rebuild the recorder via create_view_recorder, and record with surface="mcp-app".
    lineage: Lineage
    # The management surface of fixation. Exposed so the MCP side can fire the self-healing of staleness detection just like the REST side.
    fixations: FixationsApi
    # The Intent catalog (core + the default tenant's promotions). Used by the MCP side to generate intent_tools.
    intent_catalog: IntentCatalog


async def create_app(
    *,
    llm: LlmPort,
    storage: StoragePort,
    authz: AuthzPort,
    seed_dir: Path | None = None,
    prefix: str = "/api/kohaku",
) -> SalesApp:
    """Assembles the FastAPI app by converging all packages (equivalent to app.ts's createApp).

    async because it performs the startup reconciliation (reconcile) of the promotion snapshot authority -> projection.
    """
    try:
        from fastapi import FastAPI, Header
    except ImportError as err:
        raise RuntimeError(
            "Starting sales-api requires fastapi. Run `uv sync` (dev) or"
            " `pip install 'kohaku-ui[rest]'`."
        ) from err

    repo = SalesRepo(seed_dir if seed_dir is not None else default_seed_dir())
    domain = SalesDomainPort(repo)

    # Capture the core Intent names (INTENT_DEFS) as reserved words (used to reject name collisions of promoted Intents).
    core_intent_names = frozenset(IntentCatalog().names())

    # --- Per-tenant mutable catalog: promotion (publish) adds components, and the fingerprint changes per tenant ---
    def build_catalog(entries: list[PromotedEntry]) -> ResolvedCatalog:
        return resolve_catalog(
            core_catalog(),
            Catalog(components=list(sales_contribution.components)),
            Catalog(components=[promoted_component(e) for e in entries]),
        )

    registry = PromotedRegistry(build_catalog, core_intent_names)

    # NL normalization / resolve_query look up the tenant's Intent catalog (vocabulary separation of promoted Intents).
    semantic = create_semantic_port(
        repo=repo, catalog_for=registry.intent_catalog_for, llm=llm
    )

    # --- Lineage / promotion / fixation ---
    lineage = create_lineage(storage)
    recorder = create_view_recorder(lineage)
    judge = create_judge(llm=llm, pass_score=0.5)

    async def telemetry_for(artifact_id: str, tenant: str | None = None) -> tuple[int, int]:
        """Runtime telemetry aggregation: aggregates component.used arriving via telemetry (source:"telemetry").

        Narrows list_lineage by tenant: the aggregation is restricted to the given tenant so that telemetry from
        other tenants using the same artifactId does not pollute the judge input. Returns (rendered_count, error_count).
        """
        used = await storage.list_lineage(
            LineageFilter(
                type=["component.used"], artifactId=artifact_id, limit=10_000, tenant=tenant
            )
        )
        observed = [e for e in used if e.payload.get("source") == "telemetry"]
        error_count = sum(1 for e in observed if e.payload.get("outcome") == "error")
        return len(observed), error_count

    async def promotion_judge(
        candidate: PromotionCandidate, context: JudgeContext
    ) -> dict[str, Any]:
        """Promotion review (LLM-as-Judge). Called from promotions in the candidate state of the approve path.

        context.tenant is the tenant passed to approve. Used to narrow the telemetry aggregation to that tenant.
        """
        rendered, errors = await telemetry_for(candidate.artifactId, context.tenant)
        # Transcribe only when there is actual-render observation (with 0 observations, it is not placed in the prompt, as before).
        telemetry = Telemetry(rendered_count=rendered, error_count=errors) if rendered > 0 else None
        verdict = await judge.judge(
            JudgeInput(
                kind="l2-component",
                html=candidate.html if candidate.html is not None else "",
                request=candidate.request if candidate.request is not None else "",
                usage=JudgeUsage(uses=candidate.uses, sessions=candidate.sessions),
                telemetry=telemetry,
            )
        )
        # Return the rubric version and summary to the verdict, stamping "which version judged how" into component.judged.
        return {
            "pass": verdict.pass_,
            "score": verdict.score,
            "reason": verdict.summary,
            "rubricId": verdict.rubric_id,
            "rubricVersion": verdict.rubric_version,
        }

    async def validate_publish(ctx: ValidatePublishContext) -> None:
        """The pre-check gate of publish: detects name / componentType collisions before the snapshot transition.

        Throwing here means the snapshot does not transition to published and never reaches the projection (on_publish).
        The check is performed against the given tenant's catalog / Intents (independent per tenant).
        """
        registry.validate_publish(
            ctx.tenant,
            to_promoted_entry(
                artifact_id=ctx.artifactId,
                draft=ctx.draft,
                html=ctx.html,
                published_at=now_iso(),
            ),
        )

    async def on_publish(ctx: PublishContext) -> None:
        """The projection application of publish (idempotent). Reflected into the per-tenant registry.

        Persistence is handled by the snapshot (promotions.json), so no write to promoted.json is performed.
        """
        registry.publish(
            ctx.tenant,
            to_promoted_entry(
                artifact_id=ctx.artifactId,
                draft=ctx.draft,
                html=ctx.html,
                request=ctx.request,
                published_at=now_iso(),
            ),
        )

    async def on_unpublish(ctx: UnpublishContext) -> None:
        """The symmetric counterpart of on_publish. On withdrawal from published, removes it from the given tenant's catalog / Intents.

        Because the catalog fingerprint changes, an existing Spec cache containing promoted components is "made unreachable" rather than "deleted".
        """
        registry.unpublish(ctx.tenant, ctx.artifactId)

    def on_promotion_error(ctx: PromotionErrorContext, error: BaseException) -> None:
        """Observability of the (fail-open) component.published audit-record path (the demo is logging-based,
        same convention as on_compose_error). Fires when the audit record fails either at publish time or
        during a reconcile backfill attempt; the projection itself is never blocked by this (see
        create_promotions' Publish branch / reconcile docs).
        """
        tenant_label = f" (tenant={ctx.tenant})" if ctx.tenant is not None else ""
        _logger.error(
            "[promotions] failed to record the %s audit event for %s%s: %s",
            ctx.endpoint,
            ctx.artifactId,
            tenant_label,
            error,
        )

    promotions = create_promotions(
        lineage=lineage,
        storage=storage,
        # A low threshold for the demo (the production default is uses>=20, sessions>=5). The judge is advisory.
        policy=PromotionPolicy(minUses=2, minDistinctSessions=1, judgeBlocking=False),
        judge=promotion_judge,
        validate_publish=validate_publish,
        on_publish=on_publish,
        on_unpublish=on_unpublish,
        on_error=on_promotion_error,
    )
    # Snapshot authority -> projection startup reconciliation. Rebuilds the per-tenant catalogs from the published
    # snapshot. A projection left unapplied by a mid-publish failure also converges via idempotent re-application of on_publish.
    await promotions.reconcile()

    def on_fixation_error(ctx: FixationErrorContext, error: BaseException) -> None:
        """Observability of a corrupted fixation record read back from storage (the demo is logging-based,
        same convention as on_promotion_error above). A validation failure here is already fail-open (the
        record is treated as absent by the caller); this only surfaces that it happened.
        """
        tenant_label = f", tenant={ctx.tenant}" if ctx.tenant is not None else ""
        _logger.error(
            "[fixations] failed to validate a persisted fixation record for %s (intentHash=%s%s): %s",
            ctx.endpoint,
            ctx.intentHash,
            tenant_label,
            error,
        )

    fixations = create_fixations(
        lineage=lineage,
        storage=storage,
        policy=FixationPolicy(minUses=3, minDistinctSessions=1, structuralStability=0.9),
        # The source that stamps the catalog fingerprint of the given tenant at fixation time (because promotion is split per tenant).
        catalog_for=registry.component_catalog_for,
        on_error=on_fixation_error,
    )

    def analytics_summarizer(events: list[LineageEventRecord], window: Any) -> object:
        w = window if isinstance(window, AnalyticsWindow) else AnalyticsWindow()
        return summarize_lineage(
            events,
            SummarizeLineageOptions(
                tenant=w.tenant, since=w.since, until=w.until, topIntentsLimit=w.topIntentsLimit
            ),
        )

    def on_compose_error(err_ctx: ComposeErrorContext, error: BaseException | None) -> None:
        """Observability of the compose failure path (the demo is logging-based). Logs the deterministic-fallback
        demotion of L1/L2 and hard failures (Spec not delivered). It is a fire-and-forget contract, so it does not
        affect the result of compose.
        """
        intent_label = (
            f"(intent={err_ctx.intent.canonical})" if err_ctx.intent is not None else ""
        )
        if err_ctx.phase == "fallback":
            _logger.warning(
                "[compose] %s generation failed and was demoted to the deterministic fallback%s: %s",
                err_ctx.tier if err_ctx.tier is not None else "?",
                intent_label,
                err_ctx.reason if err_ctx.reason is not None else "unknown reason",
            )
        else:
            _logger.error(
                "[compose] compose failed (Spec not delivered)%s: %s", intent_label, error
            )

    # L2 verification JS sidecar (Task #39). In an environment where Node is co-located, it reuses TS's verification
    # logic (<script> syntax check + jsdom smoke) over the CLI, resolving the known Python-only differences
    # (L2_SCRIPT_SYNTAX skipped / smoke not bundled). Disabled with env KOHAKU_L2_JS=off. If unavailable (Node not
    # co-located), it is left unwired = the legacy behavior.
    l2_script_syntax = None
    l2_smoke = None
    if os.environ.get("KOHAKU_L2_JS", "") != "off":
        sidecar = create_l2_js_sidecar()
        if sidecar.is_available():
            l2_script_syntax = sidecar.lint
            l2_smoke = sidecar.smoke
            _logger.info("[compose] Enabled the L2 verification JS sidecar (cli=%s)", sidecar.cli_path)
        else:
            _logger.info(
                "[compose] The L2 verification JS sidecar is disabled (Node not co-located / CLI absent). "
                "L2_SCRIPT_SYNTAX / smoke verification will be skipped"
            )

    # The EN/JA policy pair (selected per request by policyFor via session.locale; mirrors TS
    # sample-api's compose-context). EN is the historical default policy verbatim — generatorVersion,
    # few-shot wiring, and fixed specs are byte-identical to the single-policy era. JA varies the
    # prompt (outputLanguage + JA fixed specs), so its generatorVersion carries the "/ja" token
    # (the ComposePolicy contract: prompt-content changes must vary generatorVersion). JA omits
    # fewShot: fixated few-shot examples are EN specs and would bias JA generation toward English.
    policy_en = ComposePolicy(
        allowL2=os.environ.get("KOHAKU_ALLOW_L2", "") == "1",
        # The standard views are L0 fixed Specs (do not pass through the LLM). "App UI = the solidified form of L1".
        fixedSpecs=create_fixed_specs(),
        # Application of the design system to L2 free generation (identical in content to TS sample-api): presents
        # the token vocabulary + style rules in the prompt, and the output is written with var(--kohaku-*) references
        # (direct color literals are sent back for repair by the L2_RAW_COLOR lint). The values are injected by the
        # sandbox at render time (SPEC-ENV-003).
        designSystem=SALES_DESIGN_SYSTEM,
        # Mixes the generator version into the cache key. Generation separation via the prompt revision of the
        # version that turned few-shot on by default. "/ds2" is the designSystem version (bump it when the content
        # changes — an operation that separates generations by prompt-content change).
        generatorVersion=f"{default_generator_version(llm.model_id)}/ds2",
        # few-shot self-reinforcement (3-9): supplies fixated (review-passed) Specs as examples for L1 generation.
        fewShot=create_fixation_fewshot(storage),
        # The L2 verification JS sidecar (non-None only when Node is co-located. See the is_available check above).
        l2ScriptSyntax=l2_script_syntax,
        l2Smoke=l2_smoke,
    )
    policy_ja = ComposePolicy(
        allowL2=policy_en.allowL2,
        fixedSpecs=create_fixed_specs("ja"),
        designSystem=SALES_DESIGN_SYSTEM,
        outputLanguage="Japanese",
        generatorVersion=f"{default_generator_version(llm.model_id)}/ds2/ja",
        l2ScriptSyntax=l2_script_syntax,
        l2Smoke=l2_smoke,
    )
    policy_by_lang = {"en": policy_en, "ja": policy_ja}

    compose_ctx = ComposeContext(
        # The initial value of the tenant-neutral (base) catalog. compose prefers catalog_for (with_tenant_catalog),
        # so this is rarely referenced in practice (it merely seeds the base after reconcile).
        catalog=registry.component_catalog_for(None),
        # Per-tenant catalog resolution. compose / compose_stream perform generation, verification, and cache-key
        # computation with the catalog of session.tenant (the fingerprint changes per tenant, so caches separate naturally).
        catalogFor=registry.component_catalog_for,
        semantic=semantic,
        storage=storage,
        llm=llm,
        # The default policy for direct consumers that do not resolve a session (scripts, direct
        # compose calls) — EN. The MCP host resolves a per-tool-call session (locale argument) via policyFor.
        policy=policy_en,
        # Per-session policy resolution: session.locale selects the language pair above.
        policyFor=lambda session: policy_by_lang[
            language_of(session.locale if session is not None else None)
        ],
        observer=ComposeObserver(onError=on_compose_error),
    )

    async def fixation_lookup(intent_hash: str, session: SessionContext) -> FixationRecord | None:
        """The L1->L0 fixation short-circuit (queried before compose). Looks up the given tenant's fixation by session.tenant.

        Language gate (demo policy): FixationRecord carries no language, and every pinned Spec was
        fixated from EN traffic — so the shortcut serves EN sessions only. JA sessions fall through
        to normal compose (JA cache hit or JA generation via the policy pair above).
        """
        if language_of(session.locale) != "en":
            return None
        return await storage.get_fixation(intent_hash, session.tenant)

    async def action_effects_hook(
        action: str, payload: JsonObject, result: object
    ) -> ActionEffects:
        effect = await sales_action_effects(action, payload, result)
        return ActionEffects(invalidates=effect.invalidates, refVersions=effect.refVersions)

    deps = KohakuHostDeps(
        compose=compose_ctx,
        domain=domain,
        authz=authz,
        query_source="sales",
        fixation_lookup=fixation_lookup,
        recorder=recorder,
        promotions=promotions,
        fixations=fixations,
        analytics_summarizer=analytics_summarizer,
        action_effects=action_effects_hook,
        # Authorization of the governance/audit plane (symmetric with app.ts). auth resolves the role, and
        # authorize_governance permits/denies with declarative RBAC. With x-kohaku-role=viewer, approval/deletion
        # operations become 403 CAPABILITY_DENIED.
        auth=_demo_auth,
        tenant=_demo_tenant,
        authorize_governance=create_governance_policy(_GOVERNANCE_POLICY),
    )

    app = FastAPI(title="kohaku sample sales API (Python)")
    attach_kohaku_routes(app, deps, prefix=prefix)

    # FastAPI route parameter annotations are stringified under `from __future__ import annotations`, and FastAPI
    # evaluates them with get_type_hints against the module globals. To keep the design of not placing starlette's
    # Request in the module globals (importable even without the rest extra installed), we receive x-kohaku-tenant via
    # Header rather than by Request injection (the annotation str|None resolves with builtins only).
    @app.get("/api/health")
    def health(x_kohaku_tenant: str | None = Header(default=None)) -> dict[str, Any]:
        # health shows the tenant-neutral (base) catalog (if x-kohaku-tenant is present, it looks at that tenant).
        tenant = x_kohaku_tenant or None
        return {
            "ok": True,
            "llm": {"provider": llm.provider, "model": llm.model_id},
            "seed": {"records": len(repo.records), "dataVersion": repo.data_version()},
            "catalogVersion": registry.component_catalog_for(tenant).fingerprint,
            "intents": registry.intent_catalog_for(tenant).names(),
            # promoted is the promoted componentTypes across all tenants (deduplicated). See /catalog for the per-tenant breakdown.
            "promoted": registry.all_promoted_component_types(),
        }

    @app.post("/api/admin/bump-data-version")
    def bump_data_version() -> dict[str, str]:
        # A demo endpoint that advances the data version to demonstrate cache invalidation.
        return {"dataVersion": repo.bump()}

    return SalesApp(
        app=app,
        repo=repo,
        compose_ctx=compose_ctx,
        deps=deps,
        domain=domain,
        lineage=lineage,
        fixations=fixations,
        # Exposes base (tenant-neutral + the default tenant's promotions) (used by the MCP side to generate intent_tools).
        intent_catalog=registry.intent_catalog_for(None),
    )
