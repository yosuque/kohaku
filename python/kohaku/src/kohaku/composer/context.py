"""compose context, policy, and observer hooks (port of TS context.ts)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Any, Literal, Protocol

from kohaku.llm import LlmEffort, LlmPort
from kohaku.registry import ResolvedCatalog, SurfaceCapabilities
from kohaku.spec import (
    UNDEFINED,
    DataShape,
    Intent,
    QueryHandle,
    SemanticPort,
    SessionContext,
    StoragePort,
    UISpec,
    canonical_stringify,
    sha256_hex,
)

from .budget import ComposeBudget
from .design_system import DesignKitVocabulary, DesignSystemGuide
from .prompt import FewShotExample
from .trace import ComposeTrace, TraceInput

if TYPE_CHECKING:
    from .post import PostRule


class FixedSpecSource(Protocol):
    """Source for L0 (fixed screens). canonical intent → fixed Spec template.

    lookup returns either a UISpec itself, or a function that builds a UISpec from (intent, refs).
    """

    async def lookup(
        self, intent: Intent
    ) -> UISpec | Callable[[Intent, list[QueryHandle]], UISpec] | None: ...


@dataclass(frozen=True)
class L2SmokeContext:
    """Context passed to the pre-delivery L2 smoke-verification hook (equivalent to TS `{ ref?, shape? }`)."""

    ref: str | None = None
    shape: DataShape | None = None


@dataclass(frozen=True)
class FewShotPolicy:
    """Supplies good examples (few-shot) to L1 generation for self-reinforcement.

    examples must be deterministic for the same intent (cache consistency). Turning it on/off or changing
    the source changes the prompt content, so generatorVersion must be bumped. A throw does not stop
    generation (l1_generate swallows it and treats the result as empty).
    """

    examples: Callable[[Intent], Awaitable[list[FewShotExample]]]
    maxExamples: int = 2
    id: str | None = None
    """An optional identifier for this few-shot supply source. When present, it is folded into
    policy_fingerprint() so that swapping the example source for the same policy shape automatically
    separates the cache key; when absent it fingerprints as "anonymous" (not required — existing callers
    that never set it see no change)."""


@dataclass(frozen=True)
class EffortPolicy:
    """Per-tier Adaptive Reasoning effort (port of TS's `ComposePolicy.effort: { l1?; l2? }`), threaded to
    the L1 constrained generation call (l1_generate.py) and the L2 free-form HTML call (l2_generate.py)
    respectively as `GenerateObjectRequest`/`GenerateTextRequest.effort`. l1/l2 are independent: L1 is
    constrained catalog selection (usually cheap to reason about) while L2 is free-form generation (may
    benefit from more effort) — an operator can set either, both, or neither. A tier left unset sends no
    `effort` at all for that call (provider default; identical to this field never existing). A port that
    does not implement effort control (FakeLlm, or a provider adapter with no matching option) ignores it.

    Included in `policy_fingerprint` whenever `ComposePolicy.effort` is set at all (any l1/l2 combination,
    including both left unset) because effort can change the generated output for the same Intent/model.
    **When unspecified, `policy_fingerprint` and the cacheKey are completely unchanged** (same contract as
    `refConstraint`).
    """

    l1: LlmEffort | None = None
    l2: LlmEffort | None = None


@dataclass(frozen=True)
class ComposePolicy:
    cacheMode: Literal["default", "bypass"] = "default"
    cacheFailure: Literal["open", "closed"] = "open"
    """How a Spec-cache backend failure (get_spec_cache/put_spec_cache raising) is handled. Default
    "open": the failure is reported to observer.onError with phase "cache" and treated as a lookup miss
    / a skipped store, so a Spec is still delivered even when the cache backend is down. "closed"
    re-raises the original error instead (compose fails), for callers that need the identical-display
    guarantee to be strict rather than degrade silently."""
    maxRepairAttempts: int = 1
    """Maximum number of repair "re"-attempts on L1/L2 generation failure (with the first attempt, up to 2 LLM calls)"""
    fixedSpecs: FixedSpecSource | None = None
    extraRules: list[PostRule] = field(default_factory=list)
    """Product-extension rules for deterministic post-processing (applied after the 4 standard rules)"""
    allowL2: bool = False
    """When False (the default), an L1 failure = the deterministic presentMarkdown fallback Spec"""
    routeTier: Callable[[Intent], Literal["L1", "L2"] | None] | None = None
    """Routing such as skipping L1 and going straight to L2 depending on the intent"""
    ttlSeconds: int | None = None
    generatorVersion: str | None = None
    """Generator version. When given it becomes the 6th component of the cache key; when unset the classic 5-component key is used."""
    selectComponents: Callable[[Intent, ResolvedCatalog], list[str] | None] | None = None
    """Narrows the candidate vocabulary for L1 generation. Must be deterministic for the intent.

    An optional `id` attribute may be set on the callable (Python functions accept arbitrary attributes:
    `fn.id = "..."`). When present, it is folded into policy_fingerprint() so swapping the implementation
    for the same policy shape automatically separates the cache key; when absent it fingerprints as
    "anonymous" (not required — existing callers that never set it see no change)."""
    outputLanguage: str | None = None
    """The language of user-visible text in generated output (L1 heading titles, L2 widget text).
    Inserted into the generation prompts as an "Output language" section. Default "English".
    Changing it changes the prompt content — always bump generatorVersion (same rule as designSystem/fewShot)."""
    fewShot: FewShotPolicy | None = None
    designSystem: DesignSystemGuide | None = None
    """Design-system application for L2 free-form generation (optional). When given, a section with the
    token vocabulary + natural-language rules is inserted into the L2 prompt, and the generated output
    is contracted to write styles via token references var(--kohaku-*) (the actual values are injected by
    the sandbox at render time — preserving SPEC-ENV-003 theme independence). enforceTokenColors
    (default True) lints hard-coded colors (L2_RAW_COLOR) and sends them back for repair. **Changing the
    content or turning it on/off changes the prompt content, so generatorVersion must be bumped** (same
    rule as few-shot)."""
    budget: ComposeBudget | None = None
    """Cost/token budget guard. When unset, behavior and performance are completely unchanged."""
    l2ScriptSyntax: Callable[[str], Awaitable[list[str]]] | None = None
    """Hook for the <script> syntax check (L2_SCRIPT_SYNTAX) of L2-generated HTML (a Python-specific additive field).

    In TS this is built into collect_l2_issues (compiled via new Function), but Python has no JS runtime,
    so it is made injectable. When wired, it is called after the static lint (collect_l2_issues) passes and
    before l2Smoke, and its return value is merged into the existing lint. The standard implementation is
    l2_js_sidecar.create_l2_js_sidecar().lint (delegates to the TS CLI in an environment where Node is
    co-located). A throw is fail-open (check skipped = classic behavior). When unwired, L2_SCRIPT_SYNTAX
    is skipped as before (see the module docstring of l2_lint.py)."""
    l2Smoke: Callable[[str, L2SmokeContext], Awaitable[list[str]]] | None = None
    """Pre-delivery smoke verification of L2-generated HTML (optional). Called after the static lint
    (collect_l2_issues) passes; if its return value is non-empty it is sent back as repair issues ([] = pass).
    A throw is fail-open (check skipped = classic behavior, same style as the budget hook — a verifier
    failure must not stop L2 delivery). When unwired, behavior is completely unchanged.

    Python has no JS runtime, so a jsdom-equivalent runner is not bundled, but in an environment where Node
    is co-located you can wire l2_js_sidecar.create_l2_js_sidecar().smoke to reuse the TS verifier
    (@kohaku-ui/sandbox/smoke) across the CLI (Task #39). When unwired (standalone), the gaps are the same
    known difference as the L2_SCRIPT_SYNTAX skip."""
    refConstraint: Literal["schema", "validate"] = "schema"
    """How `data.$ref` on L1-generated components is constrained to the resolved QueryHandle set (port of
    TS's `ComposePolicy.refConstraint`; see its doc for the full rationale). Default "schema" (unchanged
    conventional behavior): `generate_l1` pins `data.$ref` to an enum of the resolved reference URIs in the
    generation schema. "validate": the generation schema instead leaves `data.$ref` as a plain string, and
    `_collect_issues` explicitly checks set-membership after generation, sending a `DATA_REF_UNRESOLVED`
    repair issue back into the loop when a reference falls outside the resolved set — trading the
    schema-level guarantee for a generation grammar that no longer varies with the resolved reference set.
    Participates in `policy_fingerprint` only when set to "validate" (the default never perturbs an
    existing cache key)."""
    effort: EffortPolicy | None = None
    """Per-tier Adaptive Reasoning effort. See `EffortPolicy`'s doc for the full contract."""


def _kit_fingerprint_material(kit: DesignKitVocabulary) -> dict[str, object]:
    """Converts a DesignKitVocabulary to policy_fingerprint material (port of the object TS folds in
    verbatim via `designSystem.kit ?? undefined` — see that field's own note in `policy_fingerprint`'s
    docstring). `skeleton` is folded in as an ABSENT key (`UNDEFINED`), not `None`, when unset — mirroring
    the TS side, where an unset optional `skeleton?: string` is simply not a present key on the object
    literal (not an explicit `undefined`)."""
    return {
        "id": kit.id,
        "version": kit.version,
        "classes": dict(kit.classes),
        "utilities": list(kit.utilities),
        "namespaces": list(kit.namespaces),
        "skeleton": kit.skeleton if kit.skeleton is not None else UNDEFINED,
    }


def policy_fingerprint(
    policy: ComposePolicy, tier_llm: TierLlmFingerprintMaterial | None = None
) -> str:
    """Canonical fingerprint (16 hex characters) of the ComposePolicy fields that change prompt content but
    were, until now, only enforced by the operational convention of bumping generatorVersion by hand
    (outputLanguage / designSystem / fewShot's supply source / selectComponents' narrowing function).
    prepare_compose feeds the result into cache_key() as the 7th component (port of TS composer/
    context.ts's policyFingerprint).

    **Returns the empty string when none of the fields are set to a non-default value** — cache_key()
    treats an empty policyFingerprint exactly like an omitted one, so a policy that never touches these
    fields produces a cache key byte-identical to before this function existed. `refConstraint` folds in
    only when set to "validate" (its default "schema" is indistinguishable from unset).

    fewShot / selectComponents are callables (their behavior cannot be inspected), so only their optional
    `id` participates (default "anonymous" when unset). designSystem folds in `tokens`, `guidelines`, and
    `enforceTokenColors` unconditionally, plus two design-kit fields added by the Task 7b/10 mirror: `kit`
    folds in the whole object (via `_kit_fingerprint_material`) whenever set — a different `id`, `version`,
    `classes`, `utilities`, `namespaces` or `skeleton` all separate the cache, matching
    `design_kit_prompt_fragment`'s effect on the L2 prompt — and `enforceKitClasses` folds in **only when
    explicitly `False`**, the same non-default-only pattern as `refConstraint` below, because both `True`
    and unset mean "the lint runs" and must stay indistinguishable so a kit-less or already-linted cache key
    is untouched by this addition.

    **A field folded in "only when non-default" must be written as `UNDEFINED` (the sentinel
    `kohaku.spec.canonical_json` drops from a dict), never as an explicit `None`**: `canonical_stringify`
    keeps a `None` dict value as JSON `null` but drops an `UNDEFINED` one entirely (mirroring the TS
    `canonicalStringify`'s `sortDeep`, which drops `undefined` entries but keeps `null` ones) — so a `None`
    default here would still change the hashed bytes, and therefore the cache key, for every policy that
    never touches `kit` / `enforceKitClasses`. `UNDEFINED` is the only value that reproduces the
    pre-existing byte layout exactly (see the pinned regression in test_policy_fingerprint.py).

    `policy.effort` participates in full (both l1/l2, defaulted to None when only one is set) whenever the
    object is set at all — effort changes generated output for the same Intent/model, so any caller that
    wires it (even to `EffortPolicy()` with neither tier set — an edge case, but still a distinct policy
    shape from never wiring the field) gets a separated cache key. Never set is indistinguishable from unset.

    The optional `tier_llm` argument (compose.py computes it via `tier_llm_fingerprint_material(ctx)` — see
    that function's own doc) folds in the identity of the models actually used per tier when
    `ComposeContext.llmByTier` is wired to something that actually differs from the base `ctx.llm`. None
    (its default) whenever `llmByTier` is unset or matches the base model everywhere, so a caller that never
    touches `llmByTier` sees no change here either.

    Note: this is an internal, process-local cache-partitioning hash, not a wire value — it is not required
    to (and in general will not) byte-match the TS implementation's hash for an equivalent policy, since
    e.g. DesignSystemGuide.enforceTokenColors defaults to True in Python vs. unset (None) in TS. Only the
    empty-string-iff-nothing-set invariant is a cross-language contract.
    """
    output_language = policy.outputLanguage
    design_system = policy.designSystem
    few_shot = policy.fewShot
    select_components = policy.selectComponents
    effort = policy.effort
    has_non_default_ref_constraint = policy.refConstraint == "validate"
    has_effort = effort is not None
    has_tier_llm = tier_llm is not None
    if (
        output_language is None
        and design_system is None
        and few_shot is None
        and select_components is None
        and not has_non_default_ref_constraint
        and not has_effort
        and not has_tier_llm
    ):
        return ""
    material: dict[str, object] = {
        "outputLanguage": output_language,
        "designSystem": (
            {
                "tokens": design_system.tokens,
                "guidelines": design_system.guidelines,
                "enforceTokenColors": design_system.enforceTokenColors,
                # Folded in only when non-default, and as an ABSENT key (UNDEFINED) rather than an
                # explicit None — see this function's own docstring for why. UNDEFINED is the only value
                # that reproduces the pre-existing byte layout exactly for every design-system policy that
                # never touches either field.
                "kit": (
                    _kit_fingerprint_material(design_system.kit)
                    if design_system.kit is not None
                    else UNDEFINED
                ),
                "enforceKitClasses": (
                    False if design_system.enforceKitClasses is False else UNDEFINED
                ),
            }
            if design_system is not None
            else None
        ),
        "fewShotId": (
            (few_shot.id if few_shot.id is not None else "anonymous") if few_shot is not None else None
        ),
        "selectComponentsId": (
            (getattr(select_components, "id", None) or "anonymous") if select_components is not None else None
        ),
        "refConstraint": "validate" if has_non_default_ref_constraint else None,
        "effort": {"l1": effort.l1, "l2": effort.l2} if effort is not None else None,
        "tierLlm": (
            {
                "l1": (
                    {"provider": tier_llm.l1.provider, "modelId": tier_llm.l1.model_id}
                    if tier_llm.l1 is not None
                    else None
                ),
                "l2": (
                    {"provider": tier_llm.l2.provider, "modelId": tier_llm.l2.model_id}
                    if tier_llm.l2 is not None
                    else None
                ),
            }
            if tier_llm is not None
            else None
        ),
    }
    return sha256_hex(canonical_stringify(material))[:16]


@dataclass(frozen=True)
class ComposeErrorContext:
    """Context passed to the observer hook on compose failure.

    phase:
    - "hard" = compose raised (no Spec delivered). A failure in normalize / reference resolution / final validation.
    - "fallback" = L1/L2 failed and fell back to the deterministic degraded Spec (a Spec is delivered but generation failed).
    - "cache" = the Spec cache backend (get_spec_cache/put_spec_cache) raised. Fail-open by default
      (ComposePolicy.cacheFailure): the lookup is treated as a miss / the store is skipped and a Spec is
      still delivered; set to "closed" to re-raise instead.
    - "cancelled" = the same deterministic-downgrade path as "fallback", but the cause was the caller's
      AbortSignal firing (a client disconnect/timeout) rather than an actual generation failure. Hosts use
      this to skip lineage recording (view.composed/view.fallback) so cancels do not inflate the fallback-rate analytics.
    """

    phase: Literal["hard", "fallback", "cache", "cancelled"]
    input: TraceInput
    intent: Intent | None = None
    cacheKey: str | None = None
    tier: Literal["L1", "L2"] | None = None
    """The stage that failed (as far as is known). Unset for a normalize / reference-resolution failure."""
    reason: str | None = None
    budgetExceeded: bool = False
    """True when the degradation was caused by the budget guard (for machine discrimination that does not rely on string-matching reason)."""


@dataclass(frozen=True)
class BudgetCheckErrorContext:
    """Context passed to the observer hook when a throw from the budget hook check() was swallowed fail-open.

    This is not a compose failure (generation continues and a Spec may still be delivered normally).
    """

    input: TraceInput
    intent: Intent
    cacheKey: str
    tier: Literal["L1", "L2"]


@dataclass(frozen=True)
class ComposeObserver:
    """Observer hooks. All fire-and-forget (throws are swallowed on the composer side)."""

    onComposed: Callable[[ComposeTrace, UISpec], Awaitable[None] | None] | None = None
    onError: (
        Callable[[ComposeErrorContext, BaseException | None], Awaitable[None] | None] | None
    ) = None
    onBudgetCheckError: (
        Callable[[BudgetCheckErrorContext, BaseException], Awaitable[None] | None] | None
    ) = None


@dataclass(frozen=True)
class TierLlm:
    """Per-tier LlmPort override (port of TS's `ComposeContext.llmByTier: { L1?; L2? }`). See that field's
    own doc on `ComposeContext` for the full contract."""

    L1: LlmPort | None = None
    L2: LlmPort | None = None


@dataclass(frozen=True)
class ComposeContext:
    catalog: ResolvedCatalog
    semantic: SemanticPort
    storage: StoragePort
    llm: LlmPort
    catalogFor: Callable[[str | None], ResolvedCatalog] | None = None
    """Per-tenant catalog resolution (optional). The returned catalog must be deterministic."""
    surface: SurfaceCapabilities | None = None
    """When given, capability negotiation (negotiate) is performed after compose"""
    policy: ComposePolicy | None = None
    policyFor: Callable[[SessionContext | None], ComposePolicy | None] | None = None
    """Per-session policy resolution (optional). Resolved exactly once at the entry of
    compose / compose_stream (after with_tenant_catalog); returning None keeps `policy`.
    Must be deterministic with respect to the session fields it reads (e.g. locale), and any
    variation that changes prompt content MUST be reflected in the returned policy's
    generatorVersion (same rule as outputLanguage / fewShot / designSystem) — the cache key
    has no session component of its own."""
    observer: ComposeObserver | None = None
    llmByTier: TierLlm | None = None
    """Per-tier LlmPort override (optional, additive). `llm` above stays required and is the fallback for
    any tier not overridden here — so a ComposeContext that never sets `llmByTier` resolves every tier to
    `llm`, identically to before this field existed. Lets an operator plug a small fine-tuned model (see
    `kohaku dataset export`, aimed at exactly the L1 constrained-generation task) into L1 while keeping a
    larger model for L2's free-form generation, or vice versa. Resolved per tier at the point of dispatch
    (`resolve_tier_llm`, called from l1_generate.py / l2_generate.py).

    Cache-key correctness: the identity (provider+model_id) of the models actually used per tier is folded
    into `policy_fingerprint`'s extra material (`tier_llm_fingerprint_material`, computed by compose.py from
    this field) **only when at least one set tier's provider/model_id differs from `llm`'s** — so wiring
    `llmByTier` with entries that happen to match the base model changes nothing, and leaving it unset is
    always byte-identical to before. `default_generator_version` (prompt.py) deliberately stays derived from
    the base model_id only; the fingerprint, not generatorVersion, is what separates the cache when per-tier
    models diverge."""

    def with_tenant_catalog(self, tenant: str | None) -> ComposeContext:
        """Returns a ComposeContext with the catalog swapped to session.tenant's (self when catalogFor is unwired).

        The storage reference is preserved (the single-flight in-flight table is keyed by storage).
        """
        if self.catalogFor is None:
            return self
        return ComposeContext(
            catalog=self.catalogFor(tenant),
            semantic=self.semantic,
            storage=self.storage,
            llm=self.llm,
            catalogFor=self.catalogFor,
            surface=self.surface,
            policy=self.policy,
            policyFor=self.policyFor,
            observer=self.observer,
            llmByTier=self.llmByTier,
        )

    def with_session_policy(self, session: SessionContext | None) -> ComposeContext:
        """Returns a ComposeContext with the policy swapped to the session's (self when policyFor is
        unwired or returns None — byte-identical behavior). Resolved once at the entry of
        compose / compose_stream, after with_tenant_catalog and before prepare_compose, so the
        cache key (which reads policy.generatorVersion) and every downstream policy read see the
        session policy."""
        if self.policyFor is None:
            return self
        policy = self.policyFor(session)
        if policy is None:
            return self
        return ComposeContext(
            catalog=self.catalog,
            semantic=self.semantic,
            storage=self.storage,
            llm=self.llm,
            catalogFor=self.catalogFor,
            surface=self.surface,
            policy=policy,
            policyFor=self.policyFor,
            observer=self.observer,
            llmByTier=self.llmByTier,
        )

    def with_policy_override(self, override: dict[str, Any] | None) -> ComposeContext:
        """Returns a ComposeContext with `override` shallow-merged onto the resolved policy (self when
        override is None/empty — byte-identical behavior).

        Applied last, after with_session_policy, so that a caller-level policy decision (recompose's
        respect_prev_tier routing to L2, for instance) survives even when policyFor is wired — otherwise
        with_session_policy's wholesale `policy` replacement would silently discard it. Only the
        overridden fields change; every other field the session policy resolved (generatorVersion
        included) is kept.
        """
        if not override:
            return self
        return replace(self, policy=replace(self.policy or ComposePolicy(), **override))


def resolve_tier_llm(ctx: ComposeContext, tier: Literal["L1", "L2"]) -> LlmPort:
    """Resolves the LlmPort to actually use for one tier: `ctx.llmByTier[tier]` when `llmByTier` is set and
    that tier is present, otherwise the required base/fallback `ctx.llm`. Purely additive — a ComposeContext
    that never sets `llmByTier` resolves every tier to `ctx.llm`, identically to before this function
    existed. Called from l1_generate.py / l2_generate.py at the point each tier's LLM call is dispatched."""
    if ctx.llmByTier is None:
        return ctx.llm
    tier_llm = ctx.llmByTier.L1 if tier == "L1" else ctx.llmByTier.L2
    return tier_llm if tier_llm is not None else ctx.llm


@dataclass(frozen=True)
class TierModelIdentity:
    """The `{provider, model_id}` identity of one tier's resolved LlmPort — the unit `TierLlmFingerprintMaterial`
    carries per tier."""

    provider: str
    model_id: str


@dataclass(frozen=True)
class TierLlmFingerprintMaterial:
    """The extra `policy_fingerprint` material contributed by `ComposeContext.llmByTier` — see
    `tier_llm_fingerprint_material`."""

    l1: TierModelIdentity | None = None
    l2: TierModelIdentity | None = None


def tier_llm_fingerprint_material(ctx: ComposeContext) -> TierLlmFingerprintMaterial | None:
    """Computes the extra `policy_fingerprint` material for `ctx.llmByTier` (see that field's own doc on
    `ComposeContext`). Returns None — meaning "contribute nothing, cacheKey unaffected" — whenever
    `llmByTier` is unset, or whenever every tier it does set resolves to the same provider/model_id as the
    base `ctx.llm` (no actual generation difference to separate the cache for). Only when at least one set
    tier's model genuinely differs from the base does this return the `{provider, model_id}` pairs for the
    tiers `llmByTier` sets (a tier `llmByTier` never touched contributes nothing of its own — it already
    generates with the same `ctx.llm` the rest of the cache key's generatorVersion/fingerprint story covers).
    """
    if ctx.llmByTier is None:
        return None
    base_provider, base_model = ctx.llm.provider, ctx.llm.model_id

    def differs_from_base(llm: LlmPort | None) -> bool:
        return llm is not None and (llm.provider != base_provider or llm.model_id != base_model)

    if not differs_from_base(ctx.llmByTier.L1) and not differs_from_base(ctx.llmByTier.L2):
        return None
    l1 = (
        TierModelIdentity(provider=ctx.llmByTier.L1.provider, model_id=ctx.llmByTier.L1.model_id)
        if ctx.llmByTier.L1 is not None
        else None
    )
    l2 = (
        TierModelIdentity(provider=ctx.llmByTier.L2.provider, model_id=ctx.llmByTier.L2.model_id)
        if ctx.llmByTier.L2 is not None
        else None
    )
    return TierLlmFingerprintMaterial(l1=l1, l2=l2)


@dataclass(frozen=True)
class ResolvedRefs:
    handles: list[QueryHandle]
    uris: list[str]
    shapesByRef: dict[str, DataShape]
    dataVersion: str
    versionsByRef: dict[str, str]
    """$ref URI → the dataVersion of that reference alone. The fill source for Spec.refVersions."""


type OnBudgetCheckError = Callable[[BaseException], None]
type OnDraftPartial = Callable[[object], None]
"""Notification target for the in-progress state of L1 generation (the LLM's cumulative partial draft) (incremental streaming)."""
type JsonDict = dict[str, Any]
