"""Structural validation that is hard to express in zod (port of TS validate.ts).

Kept independent of schema validation to keep error codes stable:
ID uniqueness / root existence / children reference resolution / a DAG rooted at root (acyclic) /
unreachable components are warnings / event-target existence / state and bind consistency.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .canonical_json import js_string
from .models import ComponentNode, UISpec
from .predicate import collect_state_refs
from .query_ref import QueryRefError, parse_query_ref

ROOT_COMPONENT_ID = "root"

MAX_BIND_VARIANTS = 256
"""Upper bound on the total number of bind variants enumerable per Spec (curbs Cartesian-product explosion).

If the summed Cartesian product of each data.$ref's bound-parameter values exceeds this, BIND_VARIANT_LIMIT.
Prevents capability issuance at compose time (a read scope per variant) from ballooning.
"""

type SpecIssueCode = Literal[
    "DUPLICATE_ID",
    "MISSING_ROOT",
    "DANGLING_CHILD",
    "CYCLE",
    "ORPHAN_COMPONENT",
    "MULTIPLE_SANDBOX_NODES",
    "UNKNOWN_EVENT_TARGET",
    # --- Client-local state (kohaku >= 0.2) ---
    "STATE_REF_UNKNOWN",
    "STATE_SET_INVALID",
    "VERSION_FEATURE_MISMATCH",
    # --- Two-way binding data.bind (kohaku >= 0.2 [Draft]) ---
    "BIND_STATE_UNKNOWN",
    "BIND_PARAM_MISSING",
    "BIND_VALUE_INVALID",
    "BIND_PARAM_RESERVED",
    "BIND_VARIANT_LIMIT",
    # --- Server-side paging/sort ---
    "REF_RESERVED_PARAM",
    # --- Composer-time reference constraint (ComposePolicy.refConstraint) ---
    # Both codes below are emitted by the composer's L1 repair-loop set-membership check
    # (l1_generate.py's _collect_issues, mirroring TS's l1-generate.ts `collectIssues`) after a generated
    # component's data.$ref turns out not to be one of the resolved QueryHandle URIs for this compose —
    # never by validate_spec_structure in this module, which only sees the Spec itself and has no access to
    # the resolved reference set. They are included in this shared taxonomy purely so the code names are
    # stable across the TS and Python implementations and across documentation (port of TS's validate.ts; see
    # its doc for the full rationale); a consumer exhaustively matching on SpecIssueCode should treat both as
    # reachable only via composer feedback, never as an output of validate_spec_structure.
    "INVALID_REF",
    # Emitted under the default ComposePolicy.refConstraint ("schema"): the generation schema already
    # constrains data.$ref to an enum of the resolved URIs, so an out-of-set value reaching this check is a
    # bypass of that schema-stage enforcement (e.g. via the prompt-JSON fallback path, which does not enforce
    # the enum) rather than the constraint's expected operating mode.
    "DATA_REF_UNRESOLVED",
    # Emitted under ComposePolicy.refConstraint == "validate": the generation schema never constrained
    # data.$ref to an enum in the first place (it is relaxed to a plain string), so this check is the
    # *primary* enforcement mechanism for that mode, not a bypass backstop — the distinct code name lets a
    # consumer tell the two operating modes apart.
]


@dataclass(frozen=True)
class SpecIssue:
    code: SpecIssueCode
    severity: Literal["error", "warning"]
    path: str
    message: str


def validate_spec_structure(spec: UISpec) -> list[SpecIssue]:
    issues: list[SpecIssue] = []
    by_id: dict[str, ComponentNode] = {}

    for i, c in enumerate(spec.components):
        if c.id in by_id:
            issues.append(
                SpecIssue(
                    code="DUPLICATE_ID",
                    severity="error",
                    path=f"components[{i}].id",
                    message=f'component id "{c.id}" is duplicated',
                )
            )
        else:
            by_id[c.id] = c

    if ROOT_COMPONENT_ID not in by_id:
        issues.append(
            SpecIssue(
                code="MISSING_ROOT",
                severity="error",
                path="components",
                message=f'a component with id "{ROOT_COMPONENT_ID}" is required',
            )
        )

    for i, c in enumerate(spec.components):
        for child in c.children or []:
            if child not in by_id:
                issues.append(
                    SpecIssue(
                        code="DANGLING_CHILD",
                        severity="error",
                        path=f"components[{i}].children",
                        message=f'component "{c.id}" references missing child "{child}"',
                    )
                )

    # DFS from root to check reachability and cycles (children may be shared as a DAG).
    reachable: set[str] = set()
    if ROOT_COMPONENT_ID in by_id:
        in_stack: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in in_stack:
                issues.append(
                    SpecIssue(
                        code="CYCLE",
                        severity="error",
                        path="components",
                        message=f'cycle detected through component "{node_id}"',
                    )
                )
                return
            if node_id in reachable:
                return
            reachable.add(node_id)
            in_stack.add(node_id)
            node = by_id.get(node_id)
            for child in (node.children if node is not None else None) or []:
                if child in by_id:
                    visit(child)
            in_stack.discard(node_id)

        visit(ROOT_COMPONENT_ID)

        for c in spec.components:
            if c.id not in reachable:
                issues.append(
                    SpecIssue(
                        code="ORPHAN_COMPONENT",
                        severity="warning",
                        path="components",
                        message=f'component "{c.id}" is not reachable from "{ROOT_COMPONENT_ID}"',
                    )
                )

    # The composer only ever emits a single L2 (sandboxed free-generation) node per Spec, and
    # lineage.py's view_composed relies on that invariant when it picks "the" sandbox node to record as
    # component.generated. A second one would silently make lineage record only the first and drop the
    # rest, so flag it as a warning rather than let it fail silently.
    sandbox_nodes = [c for c in spec.components if c.artifact is not None]
    if len(sandbox_nodes) > 1:
        issues.append(
            SpecIssue(
                code="MULTIPLE_SANDBOX_NODES",
                severity="warning",
                path="components",
                message=(
                    "expected at most one component with an artifact (L2 sandbox node), "
                    f"found {len(sandbox_nodes)}"
                ),
            )
        )

    # SPEC §2.3: a Spec's $ref itself MUST NOT contain a reserved parameter (leading `_`).
    # Reserved parameters are the wire representation the client's resolve(ref, {page, sort}) adds, and they
    # are outside capability validation (exact match against the base ref), so their presence breaks the authorization premise.
    for i, c in enumerate(spec.components):
        if c.data is None:
            continue
        try:
            ref_params = parse_query_ref(c.data.ref).params
        except QueryRefError:
            continue  # invalidity of the $ref itself is a concern of the schema regex / the client side
        for key in ref_params:
            if key.startswith("_"):
                issues.append(
                    SpecIssue(
                        code="REF_RESERVED_PARAM",
                        severity="error",
                        path=f"components[{i}].data.$ref",
                        message=(
                            f'$ref must not contain the reserved parameter "{key}"'
                            " (parameters starting with `_` are wire-only, applied at resolve time)"
                        ),
                    )
                )

    for i, e in enumerate(spec.events):
        target_id = e.on.split(".")[0] if e.on else ""
        if target_id not in by_id:
            issues.append(
                SpecIssue(
                    code="UNKNOWN_EVENT_TARGET",
                    severity="error",
                    path=f"events[{i}].on",
                    message=f'event target component "{target_id}" does not exist',
                )
            )

    _validate_state(spec, issues)
    _validate_bind(spec, issues)

    return issues


def _validate_state(spec: UISpec, issues: list[SpecIssue]) -> None:
    """Validation of client-local state (kohaku >= 0.2).

    - VERSION_FEATURE_MISMATCH: kohaku="0.1" yet contains state / visibleWhen / state.set.
    - STATE_REF_UNKNOWN: the `$state.<key>` of visibleWhen.ref has no initial value in spec.state.
    - STATE_SET_INVALID: an emit:"state.set" payload lacks a static string key, or the key is absent from
      spec.state.
    """
    state_keys = set(spec.state.keys()) if spec.state is not None else set()
    uses_state_feature = (
        spec.state is not None
        or any(c.visibleWhen is not None for c in spec.components)
        or any(c.data is not None and c.data.bind is not None for c in spec.components)
        or any(e.emit == "state.set" for e in spec.events)
    )

    if spec.kohaku == "0.1" and uses_state_feature:
        issues.append(
            SpecIssue(
                code="VERSION_FEATURE_MISMATCH",
                severity="error",
                path="kohaku",
                message=(
                    "state / visibleWhen / state.set / data.bind require kohaku >= 0.2"
                    f' (current "{spec.kohaku}")'
                ),
            )
        )

    for i, c in enumerate(spec.components):
        if c.visibleWhen is None:
            continue
        # Recursively collect the referenced keys of all leaves (including composite predicates) and check for an initial value.
        # Deduplicate to avoid reporting the same key twice (deterministic, preserving traversal order).
        for key in dict.fromkeys(collect_state_refs(c.visibleWhen)):
            if key not in state_keys:
                issues.append(
                    SpecIssue(
                        code="STATE_REF_UNKNOWN",
                        severity="error",
                        path=f"components[{i}].visibleWhen",
                        message=(
                            f'state key "{key}" referenced by visibleWhen has no initial value'
                            " in spec.state"
                        ),
                    )
                )

    for i, e in enumerate(spec.events):
        if e.emit != "state.set":
            continue
        set_key = e.payload.get("key")
        # key must be a static string ($value / $row.* templates or non-strings are not allowed).
        if not isinstance(set_key, str) or set_key.startswith("$"):
            issues.append(
                SpecIssue(
                    code="STATE_SET_INVALID",
                    severity="error",
                    path=f"events[{i}].payload.key",
                    message="state.set payload.key must be a static state key string",
                )
            )
        elif set_key not in state_keys:
            issues.append(
                SpecIssue(
                    code="STATE_SET_INVALID",
                    severity="error",
                    path=f"events[{i}].payload.key",
                    message=f'state.set target key "{set_key}" is not declared in spec.state',
                )
            )


def _validate_bind(spec: UISpec, issues: list[SpecIssue]) -> None:
    """Structural validation of two-way binding data.bind (kohaku >= 0.2 [Draft]).

    To guarantee that the initial effective ref = $ref itself, enforce a three-way match of the initial
    values (the `$ref`'s parameter value = `spec.state[$state key]` = an element of `values`).
    """
    state_keys = set(spec.state.keys()) if spec.state is not None else set()
    total_variants = 0

    for i, c in enumerate(spec.components):
        bind = c.data.bind if c.data is not None else None
        if bind is None:
            continue
        assert c.data is not None
        base = f"components[{i}].data.bind"

        # Look up the $ref parameters (defensively, since parsing can fail even if it passed the schema regex).
        ref_params: dict[str, str] | None
        try:
            ref_params = parse_query_ref(c.data.ref).params
        except QueryRefError:
            ref_params = None  # invalidity of the $ref itself is another path's concern

        ref_variants = 1
        for param, binding in bind.items():
            ref_variants *= len(set(binding.values))
            path = f"{base}.{param}"

            if param.startswith("_"):
                issues.append(
                    SpecIssue(
                        code="BIND_PARAM_RESERVED",
                        severity="error",
                        path=path,
                        message=f'bound parameter "{param}" collides with the reserved namespace (leading _)',
                    )
                )

            if binding.state not in state_keys:
                issues.append(
                    SpecIssue(
                        code="BIND_STATE_UNKNOWN",
                        severity="error",
                        path=f"{path}.$state",
                        message=(
                            f'state key "{binding.state}" referenced by a binding has no initial value'
                            " in spec.state"
                        ),
                    )
                )

            if ref_params is not None:
                if param not in ref_params:
                    issues.append(
                        SpecIssue(
                            code="BIND_PARAM_MISSING",
                            severity="error",
                            path=path,
                            message=(
                                f'bound parameter "{param}" is missing from the $ref query'
                                " (no initial variant value)"
                            ),
                        )
                    )
                else:
                    ref_value = ref_params[param]
                    if ref_value not in binding.values:
                        issues.append(
                            SpecIssue(
                                code="BIND_VALUE_INVALID",
                                severity="error",
                                path=path,
                                message=(
                                    f'"{param}={ref_value}" in $ref is not among values'
                                    " (the initial variant must be an authorized value)"
                                ),
                            )
                        )
                    # If state has an initial value, require the three-way match (compare as strings — query values are strings).
                    if binding.state in state_keys:
                        assert spec.state is not None
                        state_value = js_string(spec.state[binding.state])
                        if state_value != ref_value:
                            issues.append(
                                SpecIssue(
                                    code="BIND_VALUE_INVALID",
                                    severity="error",
                                    path=path,
                                    message=(
                                        f'"{param}={ref_value}" in $ref does not match'
                                        f' spec.state["{binding.state}"]="{state_value}"'
                                        " (initial ref = initial state)"
                                    ),
                                )
                            )
        total_variants += ref_variants

    if total_variants > MAX_BIND_VARIANTS:
        issues.append(
            SpecIssue(
                code="BIND_VARIANT_LIMIT",
                severity="error",
                path="components",
                message=(
                    f"total bind variants {total_variants} exceed the limit {MAX_BIND_VARIANTS}"
                    " (caps capability issuance growth)"
                ),
            )
        )


def has_errors(issues: list[SpecIssue]) -> bool:
    return any(i.severity == "error" for i in issues)
