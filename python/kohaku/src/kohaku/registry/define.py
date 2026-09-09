"""Component-definition validation and freezing (Port of TS define.ts)."""

from __future__ import annotations

import re

from kohaku.spec import canonical_stringify

from .semver_util import is_valid
from .types import ComponentDefinition


class ComponentDefinitionError(Exception):
    def __init__(self, type_: str, message: str) -> None:
        super().__init__(f'component "{type_}": {message}')


_TYPE_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$")


def define_component(definition: ComponentDefinition) -> ComponentDefinition:
    """At definition time, fail-fast any inconsistency back to the catalog author.

    The TS version checks the representability of the zod -> JSON Schema conversion, but the Python version's
    propsSchema is already a JSON Schema, so it checks "whether it can be canonicalized as a JSON value"
    (rejecting functions or non-JSON values here).
    """
    if not _TYPE_RE.match(definition.type):
        raise ComponentDefinitionError(definition.type, "type must match dotted identifier form")
    if not is_valid(definition.version):
        raise ComponentDefinitionError(
            definition.type, f'version "{definition.version}" is not valid semver'
        )
    if len(definition.description.strip()) == 0:
        raise ComponentDefinitionError(
            definition.type, "description is required (used in LLM prompt)"
        )
    try:
        canonical_stringify(definition.propsSchema.json_schema)
    except TypeError as e:
        raise ComponentDefinitionError(
            definition.type, f"propsSchema is not JSON-representable: {e}"
        ) from None
    return definition
