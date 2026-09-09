"""Capability negotiation (Port of TS negotiate.ts).

Downgrades parts the surface does not implement along the definition-side fallback chain.
The terminal is presentMarkdown (a text fallback).
"""

from __future__ import annotations

from dataclasses import dataclass

from kohaku.spec import SANDBOX_HTML_TYPE, ComponentNode, ProvenanceFallback, UISpec

from .catalog import ResolvedCatalog
from .semver_util import satisfies
from .types import SurfaceCapabilities

_TERMINAL_FALLBACK = "presentMarkdown"


@dataclass(frozen=True)
class Downgrade:
    id: str
    from_: str
    to: str
    reason: str


@dataclass(frozen=True)
class NegotiateResult:
    spec: UISpec
    downgrades: list[Downgrade]


def _make_node(
    node_id: str, type_: str, version: str | None, props: dict[str, object]
) -> ComponentNode:
    """Construct while omitting the optional field (version) key itself rather than passing None."""
    extra: dict[str, object] = {"version": version} if version is not None else {}
    return ComponentNode(id=node_id, type=type_, props=props, **extra)  # type: ignore[arg-type]


def negotiate(
    spec: UISpec, catalog: ResolvedCatalog, surface: SurfaceCapabilities
) -> NegotiateResult:
    downgrades: list[Downgrade] = []

    def ver(type_: str) -> str | None:
        """Pin the catalog version on downgraded nodes too (a missing version causes inconsistency on re-validation / re-negotiation)."""
        definition = catalog.get(type_)
        return definition.version if definition is not None else None

    def negotiate_node(node: ComponentNode) -> ComponentNode:
        if node.type == SANDBOX_HTML_TYPE:
            if (surface.maxTier or "L2") == "L2":
                return node
            downgrades.append(
                Downgrade(
                    id=node.id,
                    from_=node.type,
                    to=_TERMINAL_FALLBACK,
                    reason="surface does not allow tier L2",
                )
            )
            return _make_node(
                node.id,
                _TERMINAL_FALLBACK,
                ver(_TERMINAL_FALLBACK),
                {"markdown": "(Free-form generated components cannot be displayed on this surface)"},
            )

        if _supports(surface, node.type, node.version):
            return node

        # Follow the fallback chain
        current = node
        visited = {node.type}
        while True:
            definition = catalog.get(current.type)
            fb = definition.fallback if definition is not None else None
            if fb is None or fb.type in visited:
                if current.type != _TERMINAL_FALLBACK:
                    downgrades.append(
                        Downgrade(
                            id=node.id,
                            from_=node.type,
                            to=_TERMINAL_FALLBACK,
                            reason=f'surface lacks "{node.type}" and no usable fallback chain',
                        )
                    )
                    return _make_node(
                        node.id,
                        _TERMINAL_FALLBACK,
                        ver(_TERMINAL_FALLBACK),
                        {"markdown": f"(Component {node.type} is not available on this surface)"},
                    )
                return current
            visited.add(fb.type)
            fb_def = catalog.get(fb.type)
            # Drop children / data if the downgrade target does not accept them (capabilities is "none").
            # Leaving them would produce CHILDREN_NOT_SUPPORTED / DATA_FORBIDDEN in structural validation.
            keep_children = (
                current.children is not None
                and (fb_def is None or fb_def.capabilities.children != "none")
            )
            keep_data = current.data is not None and (
                fb_def is None or fb_def.capabilities.data != "none"
            )
            # Omit the optional-field key itself rather than passing None (coexisting with wire validation's null rejection)
            extra: dict[str, object] = {}
            if ver(fb.type) is not None:
                extra["version"] = ver(fb.type)
            if keep_children:
                extra["children"] = current.children
            if keep_data:
                extra["data"] = current.data
            next_node = ComponentNode(
                id=current.id,
                type=fb.type,
                props=fb.map_props(current.props),
                **extra,  # type: ignore[arg-type]
            )
            if _supports(surface, fb.type, fb_def.version if fb_def is not None else None):
                downgrades.append(
                    Downgrade(
                        id=node.id,
                        from_=node.type,
                        to=fb.type,
                        reason=f'surface lacks "{current.type}"',
                    )
                )
                return next_node
            current = next_node

    components = [negotiate_node(node) for node in spec.components]

    if len(downgrades) == 0:
        return NegotiateResult(spec=spec, downgrades=downgrades)

    # If an existing fallback is present (e.g. "generation" from a generation failure), negotiation
    # overwrites it last-writer-wins (a simplification of one downgrade trace per Spec).
    new_provenance = spec.provenance.model_copy(
        update={
            "fallback": ProvenanceFallback.model_validate(
                {
                    "from": ",".join(f"{d.id}:{d.from_}" for d in downgrades),
                    "reason": "capability negotiation",
                    "kind": "negotiation",
                }
            )
        }
    )
    return NegotiateResult(
        spec=spec.model_copy(update={"components": components, "provenance": new_provenance}),
        downgrades=downgrades,
    )


def _supports(surface: SurfaceCapabilities, type_: str, version: str | None) -> bool:
    version_range = surface.supports.get(type_)
    if version_range is None:
        return False
    if version is None:
        return True
    return satisfies(version, version_range)
