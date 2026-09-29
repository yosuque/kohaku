"""kohaku's own JSON Schema subset for governed Action params (design.md #62/#63).

Port of TS `packages/spec-core/src/schema/action-params.ts` (the subset schema shape) and
`packages/spec-core/src/action-params.ts` (`validate_action_params` / `action_payload_hash` /
`assert_valid_action_params_schema`), merged into one module here (this repo's Python mirror keeps a
1:1 module-per-file layout going forward, but these two TS files are small enough, and tight enough in
purpose, to fold together the same way `kohaku.spec.errors` already merges `errors.ts` + `rest-errors.ts`
-- see `docs/runbooks/python-mirror.md`'s "Layout rule").

Allowed keywords (deliberately closed, no `pattern` -- see the TS module's own docstring for why): `type`,
`properties`, `required`, `additionalProperties` (only literal `False`), `enum`, `minimum` / `maximum`,
`minLength` / `maxLength`, `items`, `maxItems`, `x-message`.

`validate_action_params` / `action_payload_hash` are pinned byte-for-byte against the TS implementation by
the cross-language golden (`spec/test/fixtures/cross-language-canonical.json`'s `actionParams` entries,
checked by `test_cross_language_golden.py`). `assert_valid_action_params_schema`'s error *wording* is not
part of that golden (it is an authoring-time error, like TS's `ActionParamsSchemaError` wrapping a
`ZodError` -- never surfaced to a UI client).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, TypedDict

from .canonical_json import canonical_stringify, sha256_hex
from .models import JsonObject, JsonValue

ActionTier = Literal["auto", "confirm", "approve"]
"""Governance tier for invoking an operation (design.md #62/#63). Default (when
`OperationDescriptor.tier` is None) is "auto": no confirm/approval gate.

- "auto" -- invoked as soon as params validate.
- "confirm" -- the request body must additionally carry `confirmed: true`, or the host responds 403
  APPROVAL_REQUIRED (tier "confirm"). No token is involved; it is a same-request acknowledgement, not a
  delegated grant.
- "approve" -- the request must additionally carry a valid, unexpired, unused approval token bound to
  this exact (action, payloadHash, requester), issued by someone other than the requester (design.md #63).
"""

ActionParamsSchema = TypedDict(
    "ActionParamsSchema",
    {
        "type": Literal["object", "array", "string", "number", "integer", "boolean"],
        "properties": dict[str, "ActionParamsSchema"],
        "required": list[str],
        "additionalProperties": Literal[False],
        "enum": list[str | float | bool | None],
        "minimum": float,
        "maximum": float,
        "minLength": int,
        "maxLength": int,
        "items": "ActionParamsSchema",
        "maxItems": int,
        "x-message": str,
    },
    total=False,
)
"""The Python form of the TS `ActionParamsSchema` interface. Every key is optional (`total=False`); a
concrete instance is validated for closed-keyword-set membership by `assert_valid_action_params_schema`,
not by this `TypedDict` itself (a `TypedDict` performs no runtime checking)."""

_ALLOWED_KEYWORDS: frozenset[str] = frozenset(
    {
        "type",
        "properties",
        "required",
        "additionalProperties",
        "enum",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "items",
        "maxItems",
        "x-message",
    }
)
_ALLOWED_TYPES: frozenset[str] = frozenset({"object", "array", "string", "number", "integer", "boolean"})

# Object-key names that are always rejected as a payload property, at any nesting depth, regardless of
# the schema's own additionalProperties setting. Python dicts have no prototype chain, so `key not in
# value` / `properties.get(key)` are not vulnerable to the TS lookup bug this guards against there
# (bracket access on a plain object resolving through Object.prototype for "__proto__" / "constructor" /
# etc.) -- this set exists purely for cross-language parity, so the same payload produces the same issues
# array in both languages (pinned by the cross-language golden).
_UNSAFE_PROPERTY_KEYS: frozenset[str] = frozenset({"__proto__", "constructor", "prototype"})


@dataclass(frozen=True)
class ActionParamIssue:
    """One problem `validate_action_params` found in a payload against an `ActionParamsSchema`. Port of
    TS `action-params.ts`'s `ActionParamIssue`."""

    path: str
    """Dot-separated path into the payload (empty string for a whole-payload problem). An array index is
    rendered as `[i]` appended to its parent path (e.g. "tags[0]"), matching the TS convention exactly --
    pinned by the cross-language golden."""
    code: str
    """A stable machine-readable discriminator: "type", "required", "additionalProperties", "enum",
    "minimum", "maximum", "minLength", "maxLength", "maxItems", or "unsafeKey"."""
    message: str
    """Client-safe explanation (or the schema author's own `x-message` override)."""


def _join_path(base: str, key: str) -> str:
    return key if base == "" else f"{base}.{key}"


def _join_index(base: str, index: int) -> str:
    return f"{base}[{index}]"


def _code_point_length(value: str) -> int:
    # `minLength` / `maxLength` count Unicode code points (SPEC ACT-PRM-001) -- what Python's len() already
    # counts; the TS mirror has to count code points explicitly since JS string length is UTF-16 code units.
    return len(value)


def find_unsafe_action_param_keys(payload: JsonObject) -> list[ActionParamIssue]:
    """Scan the whole `payload` -- dicts and lists, at any depth, whether or not any schema declares those
    properties -- for a key named `__proto__` / `constructor` / `prototype`, reporting each as an
    `"unsafeKey"` issue. Port of TS `findUnsafeActionParamKeys`: the host-core gate runs it on every action
    payload before (and independently of) any params-schema validation. A flagged key's own value is not
    descended into."""
    issues: list[ActionParamIssue] = []
    _scan_unsafe_keys(payload, "", issues)
    return issues


def _scan_unsafe_keys(value: JsonValue, path: str, issues: list[ActionParamIssue]) -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            _scan_unsafe_keys(item, _join_index(path, index), issues)
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        key_path = _join_path(path, key)
        if key in _UNSAFE_PROPERTY_KEYS:
            issues.append(
                ActionParamIssue(
                    path=key_path, code="unsafeKey", message=f'the property name "{key}" is not allowed'
                )
            )
            continue
        _scan_unsafe_keys(item, key_path, issues)


def _is_number(value: object) -> bool:
    # bool is a subclass of int in Python; JS typeof true !== "number", so it must be excluded here.
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _is_integer(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def validate_action_params(schema: ActionParamsSchema, payload: JsonObject) -> list[ActionParamIssue]:
    """Validate `payload` against `schema` and return every problem found (an empty list = valid).

    Assumes `schema` has already been checked for unknown/disallowed keywords
    (`assert_valid_action_params_schema`, run once at attach time) and that `payload` has already passed
    the JSON depth precheck -- see the TS counterpart's docstring for the same two assumptions. Port of
    TS `action-params.ts`'s `validateActionParams`.
    """
    issues: list[ActionParamIssue] = []
    _validate_value(schema, payload, "", issues)
    return issues


def _validate_value(
    schema: ActionParamsSchema, value: JsonValue, path: str, issues: list[ActionParamIssue]
) -> None:
    message_override = schema.get("x-message")

    def report(code: str, message: str) -> None:
        issues.append(ActionParamIssue(path=path, code=code, message=message_override or message))

    schema_type = schema.get("type")

    if schema_type == "object":
        if not isinstance(value, dict):
            report("type", f'expected an object at "{path or "(root)"}"')
            return
        for key in schema.get("required", []):
            if key not in value:
                prop_path = _join_path(path, key)
                issues.append(
                    ActionParamIssue(
                        path=prop_path,
                        code="required",
                        message=message_override or f'missing required property "{key}"',
                    )
                )
        properties = schema.get("properties", {})
        additional_properties = schema.get("additionalProperties")
        for key, val in value.items():
            prop_path = _join_path(path, key)
            if key in _UNSAFE_PROPERTY_KEYS:
                issues.append(
                    ActionParamIssue(
                        path=prop_path,
                        code="unsafeKey",
                        message=message_override or f'the property name "{key}" is not allowed',
                    )
                )
                continue
            prop_schema = properties.get(key)
            if prop_schema is None:
                if additional_properties is False:
                    issues.append(
                        ActionParamIssue(
                            path=prop_path,
                            code="additionalProperties",
                            message=message_override or f'unexpected property "{key}"',
                        )
                    )
                continue
            _validate_value(prop_schema, val, prop_path, issues)
        return

    if schema_type == "array":
        if not isinstance(value, list):
            report("type", f'expected an array at "{path or "(root)"}"')
            return
        max_items = schema.get("maxItems")
        if max_items is not None and len(value) > max_items:
            report("maxItems", f"expected at most {max_items} items")
        items_schema = schema.get("items")
        if items_schema is not None:
            for index, item in enumerate(value):
                _validate_value(items_schema, item, _join_index(path, index), issues)
        return

    if schema_type == "string":
        if not isinstance(value, str):
            report("type", f'expected a string at "{path or "(root)"}"')
            return
        min_length = schema.get("minLength")
        if min_length is not None and _code_point_length(value) < min_length:
            report("minLength", f"expected at least {min_length} characters")
        max_length = schema.get("maxLength")
        if max_length is not None and _code_point_length(value) > max_length:
            report("maxLength", f"expected at most {max_length} characters")
        enum = schema.get("enum")
        if enum is not None and value not in enum:
            report("enum", f"expected one of {canonical_stringify(enum)}")
        return

    if schema_type in ("number", "integer"):
        if not _is_number(value) or (schema_type == "integer" and not _is_integer(value)):
            noun = "n integer" if schema_type == "integer" else " number"
            report("type", f'expected a{noun} at "{path or "(root)"}"')
            return
        # _is_number(value) guarantees an int/float (excluding bool) at runtime; narrow explicitly for
        # mypy, since JsonValue's other members (str/list/dict/None) do not support < / >.
        assert isinstance(value, (int, float))
        minimum = schema.get("minimum")
        if minimum is not None and value < minimum:
            report("minimum", f"expected at least {minimum}")
        maximum = schema.get("maximum")
        if maximum is not None and value > maximum:
            report("maximum", f"expected at most {maximum}")
        enum = schema.get("enum")
        if enum is not None and value not in enum:
            report("enum", f"expected one of {canonical_stringify(enum)}")
        return

    if schema_type == "boolean":
        if not isinstance(value, bool):
            report("type", f'expected a boolean at "{path or "(root)"}"')
            return
        enum = schema.get("enum")
        if enum is not None and value not in enum:
            report("enum", f"expected one of {canonical_stringify(enum)}")
        return


class ActionParamsSchemaError(ValueError):
    """Raised by `assert_valid_action_params_schema` when a `paramsSchema` uses a keyword outside the
    closed subset (or is otherwise structurally invalid, e.g. `additionalProperties: true`). An
    authoring-time error (a product's `DomainPort.list_operations()` returned a bad schema), never
    surfaced to a UI client as an ACTION_PARAMS_INVALID response. Port of TS `ActionParamsSchemaError`."""

    def __init__(self, operation_name: str, detail: str) -> None:
        super().__init__(f'operation "{operation_name}" has an invalid paramsSchema: {detail}')


def assert_valid_action_params_schema(operation_name: str, schema: object) -> ActionParamsSchema:
    """Validate that `schema` uses only the allowed subset of keywords, raising `ActionParamsSchemaError`
    if not. Called once per operation at attach time (`kohaku.host_core`'s operation index), not per
    request -- a per-request `validate_action_params` call assumes this has already run. Port of TS
    `assertValidActionParamsSchema`."""
    try:
        _check_schema_node(schema, "")
    except ValueError as exc:
        raise ActionParamsSchemaError(operation_name, str(exc)) from exc
    return schema  # type: ignore[return-value]  # validated structurally by _check_schema_node above


def _check_schema_node(node: object, path: str) -> None:
    label = path or "(root)"
    if not isinstance(node, dict):
        raise ValueError(f'expected a schema object at "{label}"')
    unknown = sorted(k for k in node if k not in _ALLOWED_KEYWORDS)
    if unknown:
        raise ValueError(f'unrecognized keyword(s) {unknown} at "{label}"')
    node_type = node.get("type")
    if node_type not in _ALLOWED_TYPES:
        raise ValueError(f'invalid or missing "type" at "{label}"')
    if "additionalProperties" in node and node["additionalProperties"] is not False:
        raise ValueError(f'"additionalProperties" must be literal false at "{label}"')
    required = node.get("required")
    if required is not None and (
        not isinstance(required, list) or not all(isinstance(r, str) for r in required)
    ):
        raise ValueError(f'"required" must be an array of strings at "{label}"')
    properties = node.get("properties")
    if properties is not None:
        if not isinstance(properties, dict):
            raise ValueError(f'"properties" must be an object at "{label}"')
        for key, value in properties.items():
            _check_schema_node(value, _join_path(path, key))
    items = node.get("items")
    if items is not None:
        _check_schema_node(items, f"{path}[]")


def action_payload_hash(payload: JsonObject) -> str:
    """`sha256:<hex>` of the canonical JSON of an action's invoke payload -- the same `sha256:<hex>`
    shape as `compute_intent_hash` / `compute_spec_hash` / `compute_policy_id`. Used to bind an approval
    token to the exact payload it was granted for (design.md #63) and as the lineage-recorded summary of
    a payload. Synchronous, unlike the TS `Promise<string>` (Python's hashlib is sync -- same reasoning
    as `compute_intent_hash` / `compute_policy_id`). Port of TS `actionPayloadHash`."""
    return f"sha256:{sha256_hex(canonical_stringify(payload))}"


__all__ = [
    "ActionParamIssue",
    "ActionParamsSchema",
    "ActionParamsSchemaError",
    "ActionTier",
    "action_payload_hash",
    "assert_valid_action_params_schema",
    "find_unsafe_action_param_keys",
    "validate_action_params",
]
