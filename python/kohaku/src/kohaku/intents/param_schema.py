"""A minimal schema DSL for Intent params (the substitute for zod used by TS packages/intents).

Python has no zod, so this provides a minimal DSL that ports only the range that
packages/intents/src/{intent,value-type,vocabulary}.ts rely on from
`z.object` / `z.coerce.number` / `z.enum` / `.default()` / `.optional()`. This is not a wire type but is dedicated
to in-process Intent definition (the single source for the params of the SemanticPort IntentDef, GUI facet
derivation, and parse/coerce).

Semantic correspondence with zod:
- `z.coerce.number()` = NumberField (coerce: equivalent to JS Number(); integralization narrows an integral float to int)
- `z.string()` = StringField
- `z.enum([...])` = EnumField (produced by Vocabulary.enum())
- `.int()` / `.min()` / `.max()` = NumberField flags (integer validation / range)
- `.default(v)` = fill a missing key with v (present values still get inner validation)
- `.optional()` = a missing key is dropped from the output (as in zod, an explicit null is treated as present)
- `z.object(shape).parse` strips unknown keys (zod's default strip)
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Self

from kohaku.spec import JsonObject, JsonValue


class ParamError(ValueError):
    """A params validation failure (equivalent to zod's parse exception / the error of safeParse)."""


@dataclass(frozen=True)
class ParamField:
    """The schema of a single parameter (a flat representation with the base type + folded default/optional wrappers).

    zod represents default / optional as wrapper schemas, but since value-type.ts eventually unwraps to the base
    type to decide, the Python version folds them into per-base-type subclasses as flags.
    """

    is_optional: bool = False
    has_default: bool = False
    default_value: JsonValue = None

    def optional(self) -> Self:
        """Equivalent to z.optional(). Drops a missing key from the output."""
        return replace(self, is_optional=True)

    def default(self, value: JsonValue) -> Self:
        """Equivalent to z.default(value). Fills a missing key with value."""
        return replace(self, has_default=True, default_value=value)

    def _coerce(self, value: JsonValue) -> JsonValue:
        """Coerce/validate a present input value (implemented by subclasses). Failure is ParamError."""
        raise NotImplementedError


@dataclass(frozen=True)
class NumberField(ParamField):
    """Equivalent to z.coerce.number(). Coerces a string to a number by the same rules as JS Number()."""

    integer: bool = False
    minimum: float | None = None
    maximum: float | None = None

    def _coerce(self, value: JsonValue) -> JsonValue:
        num = _to_number(value)
        # Integral floats have been narrowed to int, so if it is still a float it is non-integer.
        if self.integer and isinstance(num, float):
            raise ParamError(f"not an integer: {value!r}")
        if self.minimum is not None and num < self.minimum:
            raise ParamError(f"must be >= {self.minimum}: {num}")
        if self.maximum is not None and num > self.maximum:
            raise ParamError(f"must be <= {self.maximum}: {num}")
        return num


@dataclass(frozen=True)
class StringField(ParamField):
    """Equivalent to z.string() (no coerce — a numeric input is rejected as a type mismatch)."""

    min_length: int | None = None

    def _coerce(self, value: JsonValue) -> JsonValue:
        if not isinstance(value, str):
            raise ParamError(f"not a string: {value!r}")
        if self.min_length is not None and len(value) < self.min_length:
            raise ParamError(f"must be at least {self.min_length} characters: {value!r}")
        return value


@dataclass(frozen=True)
class EnumField(ParamField):
    """Equivalent to z.enum([...]). Only passes strings contained in the value set (insertion order)."""

    values: tuple[str, ...] = ()

    def _coerce(self, value: JsonValue) -> JsonValue:
        if not isinstance(value, str) or value not in self.values:
            allowed = ", ".join(self.values)
            raise ParamError(f"value not allowed: {value!r} (allowed: {allowed})")
        return value


def number(
    *, integer: bool = False, minimum: float | None = None, maximum: float | None = None
) -> NumberField:
    """A factory equivalent to z.coerce.number(). .int() / .min() / .max() are expressed as kwargs."""
    return NumberField(integer=integer, minimum=minimum, maximum=maximum)


def string(*, min_length: int | None = None) -> StringField:
    """A factory equivalent to z.string(). .min(n) is expressed as min_length."""
    return StringField(min_length=min_length)


@dataclass(frozen=True)
class ParamParseResult:
    """The result of safe_parse (the success/data/error subset of zod's SafeParseReturn)."""

    success: bool
    data: JsonObject | None
    error: str | None


@dataclass(frozen=True)
class ObjectSchema:
    """Equivalent to z.object(shape). parse fills defaults + coerces + strips unknown keys."""

    shape: dict[str, ParamField]

    def parse(self, raw: Mapping[str, JsonValue]) -> JsonObject:
        """Return the normalized form with coerce + default filling applied. A validation failure raises ParamError."""
        out: JsonObject = {}
        for key, field_schema in self.shape.items():
            if key not in raw:
                # Missing key: fill if there is a default, drop if optional, otherwise a required error.
                if field_schema.has_default:
                    out[key] = field_schema.default_value
                elif field_schema.is_optional:
                    continue
                else:
                    raise ParamError(f'missing required parameter "{key}"')
            else:
                out[key] = field_schema._coerce(raw[key])
        # Keys not in shape are silently dropped (zod's default strip).
        return out

    def safe_parse(self, raw: Mapping[str, JsonValue]) -> ParamParseResult:
        """Validate without raising (equivalent to zod safeParse). On failure, data=None / error set."""
        try:
            return ParamParseResult(success=True, data=self.parse(raw), error=None)
        except ParamError as exc:
            return ParamParseResult(success=False, data=None, error=str(exc))


def object_schema(shape: dict[str, ParamField]) -> ObjectSchema:
    """A factory equivalent to z.object(shape). The shape is copied and held."""
    return ObjectSchema(shape=dict(shape))


def _to_number(value: JsonValue) -> int | float:
    """Coerce to a number by the same rules as JS's Number() (an integral float is narrowed to int)."""
    if isinstance(value, bool):
        return 1 if value else 0  # JS: Number(true) === 1 / Number(false) === 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return _int_if_integral(value)
    if value is None:
        return 0  # JS: Number(null) === 0
    if isinstance(value, str):
        s = value.strip()  # JS Number() ignores leading/trailing whitespace
        if s == "":
            return 0  # JS: Number("") === 0
        try:
            parsed = float(s)
        except ValueError:
            raise ParamError(f"cannot convert to a number: {value!r}") from None
        if not math.isfinite(parsed):
            raise ParamError(f"cannot convert to a number: {value!r}")
        return _int_if_integral(parsed)
    raise ParamError(f"cannot convert to a number: {value!r}")


def _int_if_integral(f: float) -> int | float:
    """Return an integral float as an int (2026.0 → 2026. The wire/canonical representation is identical)."""
    return int(f) if f.is_integer() else f
