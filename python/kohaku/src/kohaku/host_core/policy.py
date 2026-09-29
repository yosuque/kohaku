"""Environment-neutral half of the Policy-as-Code runtime (design.md #69/#70; port of
packages/host-core/src/policy.ts).

Unlike the TS port, `load_policy_file` (the only file-reading, and therefore the only genuinely
Node-vs-browser-sensitive, half of this feature) is not split into a separate module exposed through a
package "subpath" the way TS's sibling `policy-node.ts` is: Python has no bundler/browser-tree-shaking
concern to protect against (nothing in this port ever runs in a browser), so `policy_node.py` (the 1:1
mirror of `policy-node.ts`, kept as its own module purely to preserve the "one TS file -> one Python
module" layout rule) is re-exported from this package's top-level `__init__.py` like everything else.

Also unlike the TS port, `create_policy_runtime`/`parse_policy` are **synchronous**: `compute_policy_id`
is sync in Python (hashlib, not an async Web Crypto call) -- the same reasoning `compute_intent_hash`/
`compute_spec_hash` already document. `PolicyRuntime.reload` and `PolicyRateLimiter.take` stay `async`
because they call an `audit` hook / `RateLimiter.take` that may themselves be async. For the same
reason the `policy.applied` event for the runtime's *starting* file (which the TS port fires from inside
its async `createPolicyRuntime`) is fired by awaiting `PolicyRuntime.audit_startup()` once after creation.
"""

from __future__ import annotations

import inspect
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, Literal

from kohaku.composer import (
    BudgetCheckContext,
    BudgetVerdict,
    ComposeBudget,
    ComposePolicy,
    EffortPolicy,
    TokenUsage,
)
from kohaku.spec import (
    KohakuPolicyFile,
    PolicyBudget,
    PolicyRateLimitRule,
    PolicySection,
    RateLimitResult,
    RateLimitRule,
    RateLimitStore,
    SessionContext,
    canonical_stringify,
    compute_policy_id,
    merge_policy_sections,
)

from .daily_token_ledger import DailyTokenLedger
from .rate_limit import (
    DEFAULT_MAX_MEMORY_ENTRIES,
    DEFAULT_RATE_LIMIT_TIMEOUT_MS,
    RateLimiter,
    RateLimiterErrorInfo,
    RateLimiterTakeParams,
    create_rate_limiter,
)

RouteClass = Literal["compose", "action", "resolve"]


@dataclass(frozen=True)
class ParsedPolicy:
    """A parsed and validated policy file, paired with its stable identity."""

    file: KohakuPolicyFile
    policy_id: str


def parse_policy(data: object) -> ParsedPolicy:
    """Validates `data` against `KohakuPolicyFile` and computes its `policy_id`. Raises
    `pydantic.ValidationError` on invalid input (the caller decides how to surface it -- see
    `policy_node.load_policy_file` for the file-reading counterpart)."""
    file = KohakuPolicyFile.model_validate(data)
    return ParsedPolicy(file=file, policy_id=compute_policy_id(file))


@dataclass(frozen=True)
class PolicyAppliedEvent:
    """The `policy.applied` audit event (design.md #69; SPEC is not affected -- this is a host-side
    operational concern). Fired by `reload()` only when the effective `policy_id` actually changes
    (never on a no-op reload -- reloading content with the same canonical-JSON hash, including the
    exact same file twice, is *not* an audit-worthy event). The runtime's starting file is announced once through
    `PolicyRuntime.audit_startup()` (`previousPolicyId` is None, `changedPaths` lists every top-level key
    of that file). The "policy.applied" event *type* is owned by kohaku.lineage, whose
    `Lineage.policy_applied` records this event. Field names are camelCase to match the eventual lineage payload shape (a JSON dict,
    the same convention as every other wire-adjacent type in this codebase) and the TS port 1:1.
    """

    policyId: str
    previousPolicyId: str | None
    version: int
    label: str | None
    changedPaths: list[str]
    """Dot-separated paths (e.g. "defaults.compose.allowL2", "tenants.tenant-a.compose.allowL2") whose value differs between the previous and new file."""
    tenants: list[str]
    """Every tenant key declared in the new file's `tenants` (not just the changed ones -- a full roster snapshot at the time of this change)."""


def _leaf_equals(a: object, b: object) -> bool:
    """Deep-equality check for one leaf value (object recursion is handled by the caller; this compares everything else, lists included, as a single unit)."""
    return canonical_stringify(a) == canonical_stringify(b)


def _diff_policy_paths(previous: object, next_: object, prefix: str = "") -> list[str]:
    """Collects the dot-separated paths whose value differs between `previous` and `next_` (both
    wire-shaped dicts, e.g. `KohakuPolicyFile.model_dump(by_alias=True, exclude_none=True)` -- recursing
    into nested dicts; every other value, including lists, is compared as a single leaf, so a role's
    pattern list changing is reported as one changed path, not diffed element by element). `previous`
    may itself be `None`/absent at any level (the first `reload`, or a key only one side declares) --
    every path present in `next_` alone is then reported as changed."""
    if isinstance(previous, dict) and isinstance(next_, dict):
        paths: list[str] = []
        for key in sorted(set(previous) | set(next_)):
            child_prefix = key if prefix == "" else f"{prefix}.{key}"
            paths.extend(_diff_policy_paths(previous.get(key), next_.get(key), child_prefix))
        return paths
    return [] if _leaf_equals(previous, next_) else [prefix]


def _declares_tenant(file: KohakuPolicyFile, tenant: str | None) -> bool:
    """True when `file.tenants` declares its own section for `tenant`."""
    return tenant is not None and file.tenants is not None and tenant in file.tenants


def _section_key_of(file: KohakuPolicyFile, tenant: str | None) -> str:
    """The memo key of a tenant's resolved `PolicySection`: the tenant id when the file declares a section
    for it, else one shared key -- an undeclared tenant resolves to `defaults` alone, so the many tenant
    ids a caller-controlled header can produce all share a single entry instead of growing the memo."""
    return f"t:{tenant}" if _declares_tenant(file, tenant) else "d"


def _assert_dependencies_for(
    file: KohakuPolicyFile, ledger: DailyTokenLedger | None, rate_limit_store: RateLimitStore | None
) -> None:
    """Fails fast when `file` declares a limit this runtime has no dependency to enforce: a
    `compose.budget.dailyTokens` needs a `ledger`, a `rateLimits` rule needs a `rate_limit_store`. Without
    this check such a section would be accepted and then silently never enforced."""
    sections: list[tuple[str, PolicySection]] = [("defaults", file.defaults)]
    sections.extend((f"tenants.{tenant}", section) for tenant, section in (file.tenants or {}).items())
    for where, section in sections:
        budget = section.compose.budget if section.compose is not None else None
        if ledger is None and budget is not None and budget.dailyTokens is not None:
            raise ValueError(
                f"Policy file declares {where}.compose.budget.dailyTokens but create_policy_runtime was given "
                "no `ledger`; the limit would never be enforced. Pass `ledger=create_daily_token_ledger()` "
                "or remove the setting."
            )
        rules = section.rateLimits
        if (
            rate_limit_store is None
            and rules is not None
            and (rules.compose is not None or rules.action is not None or rules.resolve is not None)
        ):
            raise ValueError(
                f"Policy file declares {where}.rateLimits but create_policy_runtime was given no "
                "`rate_limit_store`; the limits would never be enforced. Pass "
                "`rate_limit_store=create_memory_rate_limit_store()` (or your own RateLimitStore) or "
                "remove the setting."
            )


def _resolve_section(file: KohakuPolicyFile, tenant: str | None) -> PolicySection:
    """The merged `PolicySection` (`defaults` deep-merged with `tenants[tenant]`, tenant override
    winning) for one tenant. `None` tenant resolves to `defaults` alone."""
    tenant_section = file.tenants.get(tenant) if file.tenants is not None and tenant is not None else None
    base = file.defaults.model_dump(by_alias=True, exclude_none=True)
    override = tenant_section.model_dump(by_alias=True, exclude_none=True) if tenant_section is not None else {}
    return PolicySection.model_validate(merge_policy_sections(base, override))


def _create_daily_tokens_check(
    ledger: DailyTokenLedger, tenant: str | None, daily_tokens: int
) -> Callable[[], BudgetVerdict]:
    """Soft limit under concurrency, by design (design.md #69): this check is read-only (`ledger.spent`)
    and the paired `_create_daily_tokens_on_usage` writes (`ledger.record`) only after a compose actually
    completes -- there is no reservation step between the two, because a budget check must stay
    synchronous and side-effect-free (kohaku.composer calls it before starting generation and must be
    able to call it cheaply and repeatedly). N composes for the same tenant in flight at once can
    therefore all read the same `spent()` value and all pass, before any of them has recorded its own
    usage -- the day's total can overshoot `daily_tokens` by at most `(concurrent in-flight
    generations) x (the per-compose token ceiling)`. Set `compose.budget.perCompose.stopAfterTokens` to
    bound that ceiling (and so the worst-case overshoot) if the effective daily cap needs to be tighter
    under load; see kohaku.spec.policy's `PolicyBudget.dailyTokens` comment and the TS mirror
    (packages/host-core/src/policy.ts's `createDailyTokensBudgetHooks`) for the same note, and
    test_policy.py's `test_daily_tokens_is_a_soft_limit_under_concurrency` for a worked example."""
    key = tenant or ""

    def check() -> BudgetVerdict:
        spent = ledger.spent(key)
        if spent >= daily_tokens:
            return BudgetVerdict(
                allow=False,
                reason=f"Budget exceeded: daily token threshold {daily_tokens} reached (spent {spent})",
            )
        return BudgetVerdict(allow=True)

    return check


def _create_daily_tokens_on_usage(
    ledger: DailyTokenLedger, tenant: str | None
) -> Callable[[str | None, TokenUsage], None]:
    key = tenant or ""

    def on_usage(_tenant: str | None, usage: TokenUsage) -> None:
        ledger.record(key, usage.inputTokens + usage.outputTokens)

    return on_usage


def _combine_on_usage(
    base: Callable[[str | None, TokenUsage], None] | None,
    extra: Callable[[str | None, TokenUsage], None],
) -> Callable[[str | None, TokenUsage], None]:
    """Combines two `ComposeBudget.on_usage` hooks: both run, `base` first."""

    def combined(tenant: str | None, usage: TokenUsage) -> None:
        if base is not None:
            base(tenant, usage)
        extra(tenant, usage)

    return combined


def _build_effective_budget(
    base: ComposeBudget | None,
    data: PolicyBudget | None,
    tenant: str | None,
    ledger: DailyTokenLedger | None,
) -> ComposeBudget | None:
    """Assembles the effective `ComposeBudget` for one tenant: `per_compose_stop_after_tokens`/
    `deadline_ms` come from the policy file's `compose.budget` when set, else fall back to the base
    policy's own; `dailyTokens` (a policy-file-only concept) is layered on top as an additional
    check/on_usage pair backed by `ledger`.

    Because `check_with_context` takes priority over `check` whenever both are set on the same
    `ComposeBudget` (kohaku.composer.check_budget), the combined result is folded entirely into
    `check_with_context` -- which itself calls whichever of the base's own `check_with_context`/`check`
    was actually set (in that order) before layering the daily check -- and the base's plain `check` is
    dropped from the *effective* object (its behavior is not lost; it is called from inside the new
    `check_with_context` instead). This is the shape needed so a base policy that only ever set the
    plain `check` field still gets combined correctly, without this module needing to special-case which
    field the base happened to use.
    """
    daily_tokens = data.dailyTokens if data is not None else None
    per_compose = (
        data.perCompose.stopAfterTokens
        if data is not None and data.perCompose is not None
        else (base.per_compose_stop_after_tokens if base is not None else None)
    )
    deadline_ms = (
        data.deadlineMs
        if data is not None and data.deadlineMs is not None
        else (base.deadline_ms if base is not None else None)
    )
    check = base.check if base is not None else None
    check_with_context = base.check_with_context if base is not None else None
    on_usage = base.on_usage if base is not None else None

    if daily_tokens is not None and ledger is not None:
        daily_check = _create_daily_tokens_check(ledger, tenant, daily_tokens)
        daily_on_usage = _create_daily_tokens_on_usage(ledger, tenant)
        base_check, base_check_with_context = check, check_with_context

        def combined_check_with_context(ctx: BudgetCheckContext) -> BudgetVerdict:
            if base_check_with_context is not None:
                verdict = base_check_with_context(ctx)
            elif base_check is not None:
                verdict = base_check()
            else:
                verdict = BudgetVerdict(allow=True)
            return verdict if not verdict.allow else daily_check()

        check_with_context = combined_check_with_context
        check = None  # folded into check_with_context above -- see this function's own docstring
        on_usage = _combine_on_usage(on_usage, daily_on_usage)

    if per_compose is None and deadline_ms is None and check is None and check_with_context is None and on_usage is None:
        return None
    return ComposeBudget(
        per_compose_stop_after_tokens=per_compose,
        check=check,
        check_with_context=check_with_context,
        deadline_ms=deadline_ms,
        on_usage=on_usage,
    )


def _build_effective_policy(
    section: PolicySection,
    tenant: str | None,
    base: ComposePolicy,
    ledger: DailyTokenLedger | None,
) -> ComposePolicy:
    """Layers the policy file's merged `compose` section for `tenant` (`section`) onto `base` (the
    product-supplied `ComposePolicy`, which owns every function-shaped field). Only the keys the file's
    `compose` section actually sets override `base`'s own value (design.md #69)."""
    data = section.compose
    overrides: dict[str, Any] = {}
    if data is not None:
        if data.allowL2 is not None:
            overrides["allowL2"] = data.allowL2
        if data.maxRepairAttempts is not None:
            overrides["maxRepairAttempts"] = data.maxRepairAttempts
        if data.refConstraint is not None:
            overrides["refConstraint"] = data.refConstraint
        if data.effort is not None:
            overrides["effort"] = EffortPolicy(l1=data.effort.l1, l2=data.effort.l2)
        if data.outputLanguage is not None:
            overrides["outputLanguage"] = data.outputLanguage
        if data.cacheFailure is not None:
            overrides["cacheFailure"] = data.cacheFailure
        if data.ttlSeconds is not None:
            overrides["ttlSeconds"] = data.ttlSeconds
    budget = _build_effective_budget(base.budget, data.budget if data is not None else None, tenant, ledger)
    if budget is not None:
        overrides["budget"] = budget
    return replace(base, **overrides) if overrides else base


@dataclass(frozen=True)
class PolicyRateLimiterTakeParams:
    """One `PolicyRuntime.rate_limiter.take` call's parameters. `route_class` is the policy file's fixed
    rate-limit vocabulary (kohaku.spec.policy's `PolicyRateLimits`)."""

    routeClass: RouteClass
    tenant: str | None = None
    principal: str | None = None
    cost: int = 1


def _rate_limit_rule_for(section: PolicySection, route_class: RouteClass) -> RateLimitRule | None:
    if section.rateLimits is None:
        return None
    rule: PolicyRateLimitRule | None = getattr(section.rateLimits, route_class, None)
    if rule is None:
        return None
    return RateLimitRule(capacity=rule.capacity, refillPerSecond=rule.refillPerSecond)


@dataclass(frozen=True)
class RateLimitedInfo:
    """What a host's optional `on_rate_limited` observer receives when a request or tool call is denied by
    the rate limiter (host_rest's `KohakuHostDeps.on_rate_limited`, host_mcp's
    `McpHostDeps.on_rate_limited`). `principal` is the identity the bucket was keyed on (REST: the
    authenticated principal's id; MCP: see `McpHostDeps.rate_limiter`); `requestId` is the same correlation
    id the response / compose trace carries (REST: `X-Request-Id`; MCP: the tool call's correlation id).
    Field names are camelCase like the rest of this module's rate-limit types and the TS port's
    `RateLimitedInfo`."""

    routeClass: RouteClass
    requestId: str
    tenant: str | None = None
    principal: str | None = None


class PolicyRateLimiter:
    """The `rate_limiter` a `PolicyRuntime` exposes: resolves the effective `RateLimitRule` for the
    tenant/route_class from the current policy file, and always allows when none is configured (rate
    limiting is opt-in per route class) or when no `RateLimitStore` was supplied to
    `create_policy_runtime` at all."""

    def __init__(self, section_for: Callable[[str | None], PolicySection], inner: RateLimiter | None) -> None:
        self._section_for = section_for
        self._inner = inner

    async def take(self, params: PolicyRateLimiterTakeParams) -> RateLimitResult:
        if self._inner is None:
            return RateLimitResult(allow=True)
        rule = _rate_limit_rule_for(self._section_for(params.tenant), params.routeClass)
        if rule is None:
            return RateLimitResult(allow=True)
        return await self._inner.take(
            RateLimiterTakeParams(
                tenant=params.tenant,
                principal=params.principal,
                routeClass=params.routeClass,
                rule=rule,
                cost=params.cost,
            )
        )


@dataclass
class _PolicyForMemoEntry:
    base: ComposePolicy
    policy_id: str
    effective: ComposePolicy


class PolicyRuntime:
    """Built by `create_policy_runtime`; see that function's docstring for the full contract."""

    def __init__(
        self,
        file: KohakuPolicyFile,
        base_policy_for: Callable[[str | None], ComposePolicy] | None,
        ledger: DailyTokenLedger | None,
        rate_limit_store: RateLimitStore | None,
        audit: Callable[[PolicyAppliedEvent, str | None], object] | None,
        on_rate_limit_error: Callable[[RateLimiterErrorInfo], object] | None = None,
        rate_limit_timeout_ms: float | None = None,
    ) -> None:
        self._file = file
        self._policy_id = compute_policy_id(file)
        self._base_policy_for = base_policy_for
        self._ledger = ledger
        self._rate_limit_store = rate_limit_store
        self._audit = audit
        self._memo: dict[str, _PolicyForMemoEntry] = {}
        self._section_memo: dict[str, PolicySection] = {}
        self._startup_audited = False
        inner_rate_limiter = (
            create_rate_limiter(
                rate_limit_store,
                on_rate_limit_error,
                timeout_ms=(
                    rate_limit_timeout_ms if rate_limit_timeout_ms is not None else DEFAULT_RATE_LIMIT_TIMEOUT_MS
                ),
            )
            if rate_limit_store is not None
            else None
        )
        self.rate_limiter = PolicyRateLimiter(self._section_for, inner_rate_limiter)

    def _section_for(self, tenant: str | None) -> PolicySection:
        """`_resolve_section`, memoized per `_section_key_of` (cleared on every effective change): the
        merge runs once per declared tenant, not once per request."""
        key = _section_key_of(self._file, tenant)
        section = self._section_memo.get(key)
        if section is None:
            section = _resolve_section(self._file, tenant)
            self._section_memo[key] = section
        return section

    def policy_for(self, session: SessionContext | None = None) -> ComposePolicy:
        """The effective `ComposePolicy` for `session.tenant` (`base_policy_for(tenant)` with the policy
        file's merged `compose` section layered on top). Memoized per (tenant, `base_policy_for`'s
        returned object) pair -- a caller whose `base_policy_for` itself returns a stable object per
        tenant gets the identical `ComposePolicy` object back across calls, until the next effective
        `reload`. The memo is keyed by a caller-controlled tenant value, so it is LRU-bounded at
        `DEFAULT_MAX_MEMORY_ENTRIES`."""
        tenant = session.tenant if session is not None else None
        key = tenant or ""
        base = self._base_policy_for(tenant) if self._base_policy_for is not None else ComposePolicy()
        cached = self._memo.get(key)
        if cached is not None and cached.base is base and cached.policy_id == self._policy_id:
            del self._memo[key]  # reinsert to mark as most-recently-used
            self._memo[key] = cached
            return cached.effective
        effective = _build_effective_policy(self._section_for(tenant), tenant, base, self._ledger)
        self._memo.pop(key, None)
        if len(self._memo) >= DEFAULT_MAX_MEMORY_ENTRIES:
            # A dict iterates in insertion order, so the first key is the least recently used.
            del self._memo[next(iter(self._memo))]
        self._memo[key] = _PolicyForMemoEntry(base=base, policy_id=self._policy_id, effective=effective)
        return effective

    def roles_for(self, tenant: str | None = None) -> dict[str, list[str]]:
        """The effective governance roles map (host_rest's `GovernancePolicy.roles`'s shape) for
        `tenant`. `{}` when neither `defaults` nor the tenant's section declares `governance.roles`
        (deny-by-default, matching `create_governance_policy`'s own behavior on an empty map)."""
        section = self._section_for(tenant)
        return dict(section.governance.roles) if section.governance is not None else {}

    @property
    def policy_id(self) -> str:
        """The current file's `policy_id` (`sha256:<hex>`). Live: reflects the most recent `reload`."""
        return self._policy_id

    async def _fire_audit(self, event: PolicyAppliedEvent, actor: str | None) -> None:
        if self._audit is not None:
            result = self._audit(event, actor)
            if inspect.isawaitable(result):
                await result

    async def audit_startup(self) -> None:
        """Fires `audit` (if wired) once with the `PolicyAppliedEvent` for the runtime's starting file
        (`previousPolicyId` None, no actor). The TS port fires this from inside its async
        `createPolicyRuntime`; `create_policy_runtime` is synchronous here, so the caller awaits this once
        after creating the runtime. Later calls are no-ops once one has succeeded. A failure raised from
        `audit` propagates (as it does from `reload`) and leaves the startup event unrecorded, so a retry
        fires it again."""
        if self._startup_audited:
            return
        await self._fire_audit(_build_applied_event(None, None, self._file, self._policy_id), None)
        self._startup_audited = True  # only after success: a failed startup audit can be retried

    async def reload(self, file: KohakuPolicyFile, actor: str | None = None) -> None:
        """Replaces the effective policy file. Fires `audit` (if wired) with a `PolicyAppliedEvent` --
        but only when the new `policy_id` actually differs from the current one; reloading
        content with the same `policy_id` (a canonical-JSON hash, so key order and formatting do not matter)
        is a no-op (no event, memoized `policy_for` results are kept). Leaves the previous policy in force
        and raises `ValueError` when `file` declares `dailyTokens` /
        `rateLimits` and the runtime was built without the `ledger` / `rate_limit_store` that would
        enforce it. A failure raised from `audit` propagates out of `reload` (not fail-open -- an admin
        reloading a policy should see that the audit trail was not recorded, the same way the TS port
        does not swallow this)."""
        _assert_dependencies_for(file, self._ledger, self._rate_limit_store)
        policy_id = compute_policy_id(file)
        if policy_id == self._policy_id:
            return  # dedup: same canonical content is a no-op, no event, memos kept
        # Audit first, commit only on success: an unauditable policy change is not applied, and a retry
        # with the same file is not deduped away (it would otherwise never record its event).
        await self._fire_audit(_build_applied_event(self._file, self._policy_id, file, policy_id), actor)
        self._file = file
        self._policy_id = policy_id
        self._memo.clear()
        self._section_memo.clear()


def _build_applied_event(
    previous_file: KohakuPolicyFile | None,
    previous_policy_id: str | None,
    file: KohakuPolicyFile,
    policy_id: str,
) -> PolicyAppliedEvent:
    """Builds the `policy.applied` event for a change from `previous_file` (None = the runtime's starting
    file) to `file`."""
    return PolicyAppliedEvent(
        policyId=policy_id,
        previousPolicyId=previous_policy_id,
        version=file.version,
        label=file.label,
        changedPaths=_diff_policy_paths(
            previous_file.model_dump(by_alias=True, exclude_none=True) if previous_file is not None else {},
            file.model_dump(by_alias=True, exclude_none=True),
        ),
        tenants=list(file.tenants.keys()) if file.tenants is not None else [],
    )


def create_policy_runtime(
    file: KohakuPolicyFile,
    base_policy_for: Callable[[str | None], ComposePolicy] | None = None,
    ledger: DailyTokenLedger | None = None,
    rate_limit_store: RateLimitStore | None = None,
    audit: Callable[[PolicyAppliedEvent, str | None], object] | None = None,
    on_rate_limit_error: Callable[[RateLimiterErrorInfo], object] | None = None,
    rate_limit_timeout_ms: float | None = None,
) -> PolicyRuntime:
    """Builds the runtime half of Policy as Code: resolves an effective `ComposePolicy` per tenant
    (layering the policy file's data onto a product-supplied base -- design.md #69), a rate limiter
    reading the policy file's `rateLimits` section, the effective governance roles per tenant, and a
    `reload` that replaces the file and audits the change (design.md #70 covers the companion
    cache-isolation half -- `policy_fingerprint`'s `tierGate` row -- which this runtime does not itself
    touch: `policy_for`'s returned `ComposePolicy` is consumed by `compose()` exactly like a hand-written
    one, so the existing fingerprint machinery already separates the cache correctly for whatever
    allowL2/routeTier this runtime ends up resolving).

    - `base_policy_for`: the product-supplied base `ComposePolicy` per tenant -- the home for every
      function-shaped setting (`routeTier`, `fewShot`, `designSystem`, `fixedSpecs`, `l2Smoke`,
      `selectComponents`, `extraRules`; design.md #69), which the policy file's `compose` section is
      layered on top of. `None` (the default) = an empty base policy for every tenant.
    - `ledger`: backs a `compose.budget.dailyTokens` check/on_usage pair. Required when any section
      declares `dailyTokens`: `ValueError` is raised (here and from `reload`) rather than accept a file
      whose limit would silently never be enforced. The ledger is in-process only, so the budget applies
      per host instance (see `DailyTokenLedger`).
    - `rate_limit_store`: backs `rate_limiter`. Required when any section declares `rateLimits`:
      `ValueError` is raised (here and from `reload`) rather than accept a file whose limits would
      silently never be enforced. Omitted (with no `rateLimits` declared), `rate_limiter.take` always
      allows.
    - `rate_limit_timeout_ms`: forwarded as `create_rate_limiter`'s `timeout_ms` -- how long
      `rate_limiter.take` waits for `rate_limit_store.take` before failing open. Default
      `DEFAULT_RATE_LIMIT_TIMEOUT_MS`.
    - `audit`: fired by `reload()` on every effective change and, once, by `PolicyRuntime.audit_startup()`
      for the starting file; see `PolicyRuntime.reload`'s docstring. `actor` is `reload`'s own
      second argument, threaded through unchanged (never inspected by this module) -- the caller's
      lineage-wiring glue is expected to place it on the recorded event's actor field, not inside the
      payload.
    - `on_rate_limit_error`: forwarded as `create_rate_limiter`'s `on_error` -- fired (fire-and-forget)
      whenever `rate_limit_store.take` raises. `rate_limiter.take` always fails open regardless of
      whether this is wired (the request is still allowed); omitting it only means a `RateLimitStore`
      outage goes unobserved. Wire it to the same `on_error`/observability hook the rest of your host
      already uses so a rate-limit backend failure surfaces the same way any other fail-open failure
      does.
    """
    _assert_dependencies_for(file, ledger, rate_limit_store)
    return PolicyRuntime(
        file, base_policy_for, ledger, rate_limit_store, audit, on_rate_limit_error, rate_limit_timeout_ms
    )
