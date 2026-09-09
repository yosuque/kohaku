"""Parse entry point for schema validation + structure validation (port of TS parse.ts)."""

from __future__ import annotations

from dataclasses import dataclass, field

from pydantic import ValidationError

from .errors import SpecError
from .models import SpecPatch, UISpec
from .validate import SpecIssue, has_errors, validate_spec_structure


@dataclass(frozen=True)
class SpecParseOk:
    ok: bool
    spec: UISpec
    warnings: list[SpecIssue]


@dataclass(frozen=True)
class SpecParseFailed:
    ok: bool
    issues: list[SpecIssue] = field(default_factory=list)
    schema_error: str | None = None
    """Schema-validation (pydantic) failure message (equivalent to TS's zodError)."""


type SafeParseResult = SpecParseOk | SpecParseFailed


def safe_parse_spec(data: object) -> SafeParseResult:
    """Schema parse + structure validation. Warnings (e.g. ORPHAN) pass; only errors fail."""
    try:
        spec = UISpec.model_validate(data)
    except ValidationError as e:
        return SpecParseFailed(ok=False, schema_error=str(e))
    issues = validate_spec_structure(spec)
    if has_errors(issues):
        return SpecParseFailed(ok=False, issues=[i for i in issues if i.severity == "error"])
    return SpecParseOk(ok=True, spec=spec, warnings=[i for i in issues if i.severity == "warning"])


def parse_spec(data: object) -> UISpec:
    result = safe_parse_spec(data)
    if isinstance(result, SpecParseFailed):
        if result.schema_error is not None:
            raise SpecError(
                "PARSE_FAILED", f"UI Spec schema validation failed: {result.schema_error}"
            )
        raise SpecError(
            "STRUCTURE_INVALID",
            "UI Spec structure validation failed: "
            + "; ".join(f"{i.code}: {i.message}" for i in result.issues),
            result.issues,
        )
    return result.spec


@dataclass(frozen=True)
class PatchParseOk:
    ok: bool
    patch: SpecPatch


@dataclass(frozen=True)
class PatchParseFailed:
    ok: bool
    schema_error: str


type SafeParsePatchResult = PatchParseOk | PatchParseFailed


def safe_parse_patch(data: object) -> SafeParsePatchResult:
    """Schema parse of a SpecPatch. Validates only the wire-form types and value ranges.

    Does not structurally validate a patch on its own — validate_spec_structure runs inside apply_patch
    after application (no double specification).
    """
    try:
        patch = SpecPatch.model_validate(data)
    except ValidationError as e:
        return PatchParseFailed(ok=False, schema_error=str(e))
    return PatchParseOk(ok=True, patch=patch)


def parse_patch(data: object) -> SpecPatch:
    result = safe_parse_patch(data)
    if isinstance(result, PatchParseFailed):
        raise SpecError(
            "PATCH_PARSE_FAILED", f"SpecPatch schema validation failed: {result.schema_error}"
        )
    return result.patch
