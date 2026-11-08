"""JS-compatible JSON text (`JSON.stringify`) for prompt bytes (shared by the judge and the schema extractor).

The FixtureLlm key is the sha256 of system + prompt, and cross-language goldens pin prompt text, so anything
interpolated into a prompt must serialize exactly like TS: insertion key order, ES `Number::toString` numbers.
"""

from __future__ import annotations

import json
import math

from kohaku.spec import js_string


def json_stringify(value: object) -> str:
    """Equivalent to JS's JSON.stringify (preserves key order, no whitespace, passes non-ASCII through).

    Unlike canonical_stringify, keys are not sorted (JSON.stringify's insertion order is kept). Only numbers are
    delegated to the spec layer's js_string (= ES Number::toString) rather than json.dumps: json.dumps outputs an
    integer-valued float as "1.0", whereas JS's JSON.stringify outputs "1" (String(1.0) === "1"), so a mismatch in
    formatting would shift FixtureLlm's sha256 key across languages (this function's output goes into the scoring
    prompt, and the prompt is used directly as key material). Non-number formatting (string escaping / separators)
    matches between json.dumps and JSON.stringify, so that part is delegated to json.dumps.
    """
    out: list[str] = []
    _write_js_json(value, out)
    return "".join(out)


def json_stringify_pretty(value: object, indent: int = 2) -> str:
    """Equivalent to JS's `JSON.stringify(value, null, indent)` (2-space indent by default; `key: value`; empty
    containers stay `[]` / `{}`). Same number formatting and key-order rules as `_json_stringify`."""
    out: list[str] = []
    _write_js_json(value, out, " " * indent, 0)
    return "".join(out)


def _write_js_json(
    value: object, out: list[str], indent: str | None = None, level: int = 0
) -> None:
    """Append JSON.stringify-equivalent tokens to out (numbers in ES notation, everything else via json.dumps).

    `indent` None is the compact form; otherwise the pretty form of `JSON.stringify(value, null, indent)` at
    nesting `level`.
    """
    if value is None or isinstance(value, bool):
        out.append("true" if value is True else "false" if value is False else "null")
    elif isinstance(value, (int, float)):
        # JSON.stringify(NaN/Infinity) === "null". Finite values are delegated to ES Number::toString.
        if isinstance(value, float) and not math.isfinite(value):
            out.append("null")
        else:
            out.append(js_string(value))
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, (list, tuple)):
        if indent is not None and len(value) == 0:
            out.append("[]")
            return
        out.append("[")
        for i, item in enumerate(value):
            if i > 0:
                out.append(",")
            if indent is not None:
                out.append("\n" + indent * (level + 1))
            _write_js_json(item, out, indent, level + 1)
        if indent is not None:
            out.append("\n" + indent * level)
        out.append("]")
    elif isinstance(value, dict):
        if indent is not None and len(value) == 0:
            out.append("{}")
            return
        out.append("{")
        first = True
        for k, v in value.items():
            if not first:
                out.append(",")
            first = False
            if indent is not None:
                out.append("\n" + indent * (level + 1))
            out.append(json.dumps(str(k), ensure_ascii=False))
            out.append(": " if indent is not None else ":")
            _write_js_json(v, out, indent, level + 1)
        if indent is not None:
            out.append("\n" + indent * level)
        out.append("}")
    else:
        # Delegate unexpected types to json.dumps to surface them early (TypeError).
        out.append(json.dumps(value, separators=(",", ":"), ensure_ascii=False))


__all__ = ["json_stringify", "json_stringify_pretty"]
