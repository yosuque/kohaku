"""kohaku.registry — the component catalog (Port of packages/registry)."""

from .catalog import (
    Catalog,
    CatalogConflictError,
    ResolvedCatalog,
    ValidateAgainstCatalogResult,
    resolve_catalog,
)
from .core import core_catalog
from .define import ComponentDefinitionError, define_component
from .fingerprint import catalog_fingerprint, fnv1a64
from .generation import (
    GENERATION_ALWAYS_INCLUDED,
    GeneratedDraft,
    GenerationSchema,
    build_generation_schema,
    select_generation_types,
    strip_nulls,
    to_generation_props_schema,
)
from .negotiate import Downgrade, NegotiateResult, negotiate
from .props_schema import (
    PropsParseResult,
    PropsSchema,
    PropsValidationError,
    props_schema_from_json_schema,
)
from .semver_util import Semver, compare, gt, is_valid, parse_semver, satisfies
from .types import (
    CapabilityDecl,
    CatalogIssue,
    CatalogIssueCode,
    ComponentDefinition,
    FallbackDecl,
    GoldenFixtureRef,
    ImplementationDecl,
    SurfaceCapabilities,
)

__all__ = [
    "GENERATION_ALWAYS_INCLUDED",
    "Catalog",
    "CatalogConflictError",
    "CatalogIssue",
    "CatalogIssueCode",
    "CapabilityDecl",
    "ComponentDefinition",
    "ComponentDefinitionError",
    "Downgrade",
    "FallbackDecl",
    "GeneratedDraft",
    "GenerationSchema",
    "GoldenFixtureRef",
    "ImplementationDecl",
    "NegotiateResult",
    "PropsParseResult",
    "PropsSchema",
    "PropsValidationError",
    "ResolvedCatalog",
    "Semver",
    "SurfaceCapabilities",
    "ValidateAgainstCatalogResult",
    "build_generation_schema",
    "catalog_fingerprint",
    "compare",
    "core_catalog",
    "define_component",
    "fnv1a64",
    "gt",
    "is_valid",
    "negotiate",
    "parse_semver",
    "props_schema_from_json_schema",
    "resolve_catalog",
    "satisfies",
    "select_generation_types",
    "strip_nulls",
    "to_generation_props_schema",
]
