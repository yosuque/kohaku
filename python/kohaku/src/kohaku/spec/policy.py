"""Declarative Policy-as-Code file (design.md #69; port of packages/spec-core/src/schema/policy.ts).

A JSON document that layers tenant overrides on top of a default ComposePolicy/rate-limit/RBAC shape,
so a governance operator can change per-tenant behavior (L2 on/off, budgets, RBAC roles) without a
code change or redeploy.

**Scope boundary (design.md #69)**: only the *data* half of policy lives here. A field of
`ComposePolicy` that is itself a function (route_tier, few_shot, design_system, fixed_specs,
l2_smoke, select_components, extra_rules) cannot be expressed in JSON and stays product code, supplied
as the base ComposePolicy the runtime layers this file's `compose` section onto (see host_core's
`create_policy_runtime`). This schema intentionally has no field for any of them.

Every model here is `extra="forbid"` (unknown keys rejected): a policy file is operator-authored and
hand-edited, so a typo'd key should fail loudly at load time rather than be silently ignored -- unlike
`kohaku.spec.models`'s wire models, which are `extra="ignore"` to mirror zod's default (strip)
behavior for the Renderer<->host wire protocol.

**Explicit JSON `null` is rejected, matching the TS port**: zod's `.optional()` accepts a missing key but
rejects an explicit `null` (none of this schema's fields are `.nullable()` on the TS side). Pydantic's
plain `X | None = None` fields would otherwise silently accept `null` too, since `None` is a valid value
for that type -- `_PolicyModel._reject_explicit_null` (below) is what makes "the key is present but
null" fail loudly instead, for every model in this file (they all subclass `_PolicyModel`).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .canonical_json import canonical_stringify, sha256_hex

# Duplicated from kohaku.llm's LlmEffort as a plain literal, not imported: kohaku.spec sits at the
# base of the layer-direction contract (python/pyproject.toml's [tool.importlinter] "layers") and must
# not import kohaku.llm. Keep in sync with packages/llm/src/port.ts's LlmEffort / kohaku.llm.port by hand.
type PolicyEffortLevel = Literal["low", "medium", "high", "xhigh", "max"]


class _PolicyModel(BaseModel):
    """Shared config: every object in a policy file is closed (extra="forbid") -- see module docstring."""

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="before")
    @classmethod
    def _reject_explicit_null(cls, data: Any) -> Any:
        """Rejects a key present with an explicit `null` value, mirroring zod's `.optional()` (accepts a
        missing key, rejects `null` unless `.nullable()` is also chained -- see the module docstring).
        Runs before field validation, on the raw (alias-keyed) input dict, so it also catches `"$schema":
        null` on `KohakuPolicyFile` before `populate_by_name` resolution."""
        if isinstance(data, dict):
            null_keys = sorted(key for key, value in data.items() if value is None)
            if null_keys:
                raise ValueError(
                    f"explicit null is not accepted for {', '.join(null_keys)} (omit the key instead)"
                )
        return data


class PolicyEffort(_PolicyModel):
    """Mirrors ComposePolicy.effort."""

    l1: PolicyEffortLevel | None = None
    l2: PolicyEffortLevel | None = None


class PolicyPerComposeBudget(_PolicyModel):
    """Mirrors ComposeBudget.perCompose."""

    stopAfterTokens: int = Field(ge=0)


class PolicyBudget(_PolicyModel):
    """Mirrors ComposeBudget, plus dailyTokens (enforced by the host-core daily-token ledger, not by
    ComposeBudget.check/onUsage directly -- see PolicyBudget.dailyTokens's TS counterpart doc)."""

    perCompose: PolicyPerComposeBudget | None = None
    deadlineMs: int | None = Field(default=None, gt=0)
    dailyTokens: int | None = Field(default=None, ge=0)


class PolicyCompose(_PolicyModel):
    """Mirrors the JSON-expressible subset of ComposePolicy."""

    allowL2: bool | None = None
    maxRepairAttempts: int | None = Field(default=None, ge=0)
    refConstraint: Literal["schema", "validate"] | None = None
    effort: PolicyEffort | None = None
    outputLanguage: str | None = None
    cacheFailure: Literal["open", "closed"] | None = None
    ttlSeconds: int | None = Field(default=None, ge=0)
    budget: PolicyBudget | None = None


class PolicyRateLimitRule(_PolicyModel):
    """A token-bucket rule: `capacity` tokens, refilled at `refillPerSecond` (host_core's RateLimitStore)."""

    capacity: int = Field(gt=0)
    refillPerSecond: float = Field(gt=0)


class PolicyRateLimits(_PolicyModel):
    compose: PolicyRateLimitRule | None = None
    action: PolicyRateLimitRule | None = None
    resolve: PolicyRateLimitRule | None = None


class PolicyGovernance(_PolicyModel):
    """Mirrors host_rest's GovernancePolicy.roles. Patterns stay plain strings (not a Literal union of
    GovernanceOperationKind): that union belongs to host_rest, which kohaku.spec must not import
    (layer direction) -- the policy runtime hands these strings to create_governance_policy as-is,
    which already treats an unrecognized pattern as a non-match (deny-by-default)."""

    roles: dict[str, list[str]]


class PolicySection(_PolicyModel):
    """One `defaults` or `tenants[tenantId]` section of a policy file."""

    compose: PolicyCompose | None = None
    rateLimits: PolicyRateLimits | None = None
    governance: PolicyGovernance | None = None


KOHAKU_POLICY_FILE_VERSION: Literal[1] = 1
"""The current (only) policy-file format version."""


class KohakuPolicyFile(_PolicyModel):
    schema_: str | None = Field(default=None, alias="$schema")
    version: Literal[1]
    label: str | None = None
    defaults: PolicySection
    tenants: dict[str, PolicySection] | None = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


def _merge_deep(base: Any, override: Any) -> Any:
    if override is None:
        return base
    if isinstance(base, dict) and isinstance(override, dict):
        merged = dict(base)
        for key, value in override.items():
            merged[key] = _merge_deep(base.get(key), value)
        return merged
    return override


def merge_policy_sections(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Deep-merges a tenant's section (wire-shaped dict, camelCase keys) on top of `defaults`: objects
    merge key by key, recursing; arrays and scalars in `override` replace `base`'s value wholesale.
    Port of policy.ts's mergePolicySections/mergeDeep. Operates on plain dicts (e.g.
    `KohakuPolicyFile.model_dump(by_alias=True, exclude_none=True)`'s `defaults`/`tenants[t]`), not on
    model instances, so host_core's create_policy_runtime can merge before constructing the effective
    ComposePolicy.
    """
    merged = _merge_deep(base, override)
    assert isinstance(merged, dict)  # base/override are both dicts, so mergeDeep's dict branch always fires
    return merged


def compute_policy_id(file: KohakuPolicyFile) -> str:
    """A stable identity for a policy file: `sha256:<hex>` of the canonical JSON of the wire-shaped
    (camelCase, no absent-optional keys) parsed file, matching the `sha256:<hex>` shape of
    compute_intent_hash/compute_spec_hash (intent.py / cache_key.py). Two files that parse to the same
    value get the same policy_id; any actual content change gets a different one. Synchronous, unlike
    the TS `Promise<string>`: Python's hashlib is sync (same reasoning as compute_intent_hash/
    compute_spec_hash, whose TS counterparts are also async only because Node's Web Crypto is)."""
    wire = file.model_dump(by_alias=True, exclude_none=True)
    return f"sha256:{sha256_hex(canonical_stringify(wire))}"
