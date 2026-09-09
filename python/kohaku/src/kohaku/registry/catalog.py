"""Federated merge and validation of the catalog (Port of TS catalog.ts)."""

from __future__ import annotations

import builtins
from dataclasses import dataclass
from typing import Any

from kohaku.spec import SANDBOX_HTML_TYPE

from .fingerprint import catalog_fingerprint
from .semver_util import gt
from .types import CatalogIssue, ComponentDefinition


class CatalogConflictError(Exception):
    pass


@dataclass(frozen=True)
class Catalog:
    """The core catalog / a product contribution (equivalent to CatalogContribution)."""

    components: list[ComponentDefinition]


@dataclass(frozen=True)
class ValidateAgainstCatalogResult:
    issues: list[CatalogIssue]
    normalized: list[dict[str, Any]]
    """Normalized nodes (wire-form dicts) with default filling applied alongside props validation"""


class ResolvedCatalog:
    """The merged catalog. Provides get / list / fingerprint / validate."""

    def __init__(self, by_type: dict[str, ComponentDefinition]) -> None:
        self._by_type = by_type
        self.fingerprint = catalog_fingerprint(
            [
                (d.type, d.version, d.implementation.html)
                if d.implementation.kind == "sandbox-template"
                else (d.type, d.version)
                for d in by_type.values()
            ]
        )

    def get(self, type_: str) -> ComponentDefinition | None:
        return self._by_type.get(type_)

    def list(self) -> builtins.list[ComponentDefinition]:
        return list(self._by_type.values())

    def validate(
        self,
        components: builtins.list[dict[str, Any]],
        events: builtins.list[dict[str, Any]] | None = None,
    ) -> ValidateAgainstCatalogResult:
        """Validation against the catalog (type existence, props, capabilities, events).

        Because it is also called on the raw nodes of an L1 generation draft (wire dicts before schema
        validation), the input is received as dicts rather than models and handled defensively.
        """
        return _validate_against_catalog(self._by_type, components, events or [])


def resolve_catalog(core: Catalog, *contributions: Catalog) -> ResolvedCatalog:
    """Federated merge: layer product/tenant contributions onto the core catalog.

    New types may be added. Overriding an existing type is only allowed when it has a "higher semver"
    (props backward compatibility is made a convention that is the catalog author's responsibility).
    """
    by_type: dict[str, ComponentDefinition] = {}
    for definition in core.components:
        if definition.type in by_type:
            raise CatalogConflictError(f'core catalog defines "{definition.type}" twice')
        by_type[definition.type] = definition
    for contrib in contributions:
        for definition in contrib.components:
            existing = by_type.get(definition.type)
            if existing is not None and not gt(definition.version, existing.version):
                raise CatalogConflictError(
                    f'contribution for "{definition.type}"@{definition.version}'
                    f" does not upgrade existing @{existing.version}"
                )
            by_type[definition.type] = definition
    return ResolvedCatalog(by_type)


def _to_plain_node(node: Any) -> dict[str, Any]:
    to_wire = getattr(node, "to_wire", None)
    if callable(to_wire):
        result = to_wire()
        assert isinstance(result, dict)
        return result
    assert isinstance(node, dict)
    return node


def _validate_against_catalog(
    by_type: dict[str, ComponentDefinition],
    components: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> ValidateAgainstCatalogResult:
    issues: list[CatalogIssue] = []
    normalized: list[dict[str, Any]] = []

    plain_components = [_to_plain_node(c) for c in components]
    for node in plain_components:
        node_type = node.get("type")
        node_id = str(node.get("id", ""))
        # L2 free-form generated nodes are outside catalog management (sandbox validates artifact integrity separately)
        if node_type == SANDBOX_HTML_TYPE:
            normalized.append(node)
            continue
        definition = by_type.get(node_type) if isinstance(node_type, str) else None
        if definition is None:
            issues.append(
                CatalogIssue(
                    code="UNKNOWN_TYPE",
                    componentId=node_id,
                    message=f'type "{node_type}" is not in the catalog',
                )
            )
            normalized.append(node)
            continue

        parsed = definition.propsSchema.safe_parse(node.get("props") or {})
        if not parsed.ok:
            issues.append(
                CatalogIssue(
                    code="PROPS_INVALID",
                    componentId=node_id,
                    message=(
                        f"props do not match {node_type}@{definition.version}: {parsed.error}"
                    ),
                )
            )
            normalized.append(node)
        else:
            normalized.append(
                {
                    **node,
                    "version": node.get("version") or definition.version,
                    "props": parsed.value,
                }
            )

        if definition.capabilities.data == "required" and node.get("data") is None:
            issues.append(
                CatalogIssue(
                    code="DATA_REQUIRED",
                    componentId=node_id,
                    message=f'type "{node_type}" requires a data $ref',
                )
            )
        if definition.capabilities.data == "none" and node.get("data") is not None:
            issues.append(
                CatalogIssue(
                    code="DATA_FORBIDDEN",
                    componentId=node_id,
                    message=f'type "{node_type}" does not accept data',
                )
            )
        children = node.get("children")
        if definition.capabilities.children == "none" and isinstance(children, list) and children:
            issues.append(
                CatalogIssue(
                    code="CHILDREN_NOT_SUPPORTED",
                    componentId=node_id,
                    message=f'type "{node_type}" does not accept children',
                )
            )

    node_by_id = {str(c.get("id", "")): c for c in plain_components}
    for event in events:
        plain_event = _to_plain_node(event)
        # Because it is also called on the raw events of an L1 generation draft (before validation), when on is
        # non-string it is reported as an issue rather than raising a TypeError.
        on = plain_event.get("on")
        if not isinstance(on, str):
            issues.append(
                CatalogIssue(
                    code="EVENT_NOT_SUPPORTED",
                    componentId=str(on) if on is not None else "",
                    message="event.on is not a string (invalid event binding)",
                )
            )
            continue
        parts = on.split(".")
        component_id = parts[0] if parts else ""
        event_name = parts[1] if len(parts) > 1 else None
        target = node_by_id.get(component_id)
        if target is None:
            continue  # the domain of structural validation (UNKNOWN_EVENT_TARGET)
        if target.get("type") == SANDBOX_HTML_TYPE:
            continue  # L2 is the domain of the bridge allowlist
        definition = by_type.get(str(target.get("type")))
        if definition is None:
            continue
        if event_name is None:
            # Report a dot-less form as malformed (to avoid the misleading does not emit "None").
            issues.append(
                CatalogIssue(
                    code="EVENT_NOT_SUPPORTED",
                    componentId=component_id,
                    message=f'event.on "{on}" is not in componentId.eventName format',
                )
            )
            continue
        if event_name not in definition.capabilities.events:
            allowed = ", ".join(definition.capabilities.events) or "none"
            issues.append(
                CatalogIssue(
                    code="EVENT_NOT_SUPPORTED",
                    componentId=component_id,
                    message=(
                        f'type "{target.get("type")}" does not emit "{event_name}"'
                        f" (allowed: {allowed})"
                    ),
                )
            )

    return ValidateAgainstCatalogResult(issues=issues, normalized=normalized)
