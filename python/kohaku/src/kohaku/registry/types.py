"""Catalog type definitions (Port of TS packages/registry/src/types.ts)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from kohaku.spec import JsonObject

from .props_schema import PropsSchema


@dataclass(frozen=True)
class CapabilityDecl:
    """A capability declaration for the events a part may fire, whether data is required, whether children are allowed, etc."""

    events: list[str]
    data: Literal["none", "optional", "required"]
    children: Literal["none", "optional"]
    editable: bool | None = None
    """Has a write path (presentForm / editable spreadsheet)"""
    surfaces: list[str] | None = None
    """When omitted, available on all surfaces"""

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "events": list(self.events),
            "data": self.data,
            "children": self.children,
        }
        if self.editable is not None:
            out["editable"] = self.editable
        if self.surfaces is not None:
            out["surfaces"] = list(self.surfaces)
        return out


@dataclass(frozen=True)
class ImplementationDecl:
    """The implementation kind. native requires implementation registration on the renderer side.

    sandbox-template is typed, version-managed parameterized HTML, still rendered inside the sandbox
    (the default output of L2 -> L1 promotion).
    """

    kind: Literal["native", "sandbox-template"]
    html: str | None = None

    def to_wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind}
        if self.html is not None:
            out["html"] = self.html
        return out


NATIVE_IMPLEMENTATION = ImplementationDecl(kind="native")


@dataclass(frozen=True)
class FallbackDecl:
    """Declaration of the downgrade target. The chain's terminal is presentMarkdown (the mandatory-text-fallback philosophy)."""

    type: str
    map_props: Callable[[JsonObject], JsonObject]


@dataclass(frozen=True)
class GoldenFixtureRef:
    fixture: str


@dataclass(frozen=True)
class ComponentDefinition:
    """A component definition. In TS propsSchema is zod, but in Python it holds a PropsSchema with the JSON
    Schema as source of truth (with a zod-strip-semantics validator)."""

    type: str
    version: str
    description: str
    """Selection guidance for the LLM (transcribed into the generation prompt)"""
    propsSchema: PropsSchema
    capabilities: CapabilityDecl
    implementation: ImplementationDecl = NATIVE_IMPLEMENTATION
    fallback: FallbackDecl | None = None
    golden: list[GoldenFixtureRef] = field(default_factory=list)
    examples: list[dict[str, Any]] = field(default_factory=list)
    generation: Literal["allowed", "excluded"] = "allowed"
    """Whether to include in the L1 generation vocabulary. "excluded" removes it from the generation
    vocabulary and prompt enumeration, so the LLM structurally cannot output that part (used for
    runtime-only parts like ui.loading)."""


@dataclass(frozen=True)
class SurfaceCapabilities:
    """The range implemented on the renderer (surface) side. Used by negotiate."""

    supports: dict[str, str]
    """type -> semver range"""
    features: list[str] | None = None
    maxTier: Literal["L0", "L1", "L2"] | None = None


type CatalogIssueCode = Literal[
    "UNKNOWN_TYPE",
    "PROPS_INVALID",
    "DATA_REQUIRED",
    "DATA_FORBIDDEN",
    "EVENT_NOT_SUPPORTED",
    "CHILDREN_NOT_SUPPORTED",
]


@dataclass(frozen=True)
class CatalogIssue:
    code: CatalogIssueCode
    componentId: str
    message: str
