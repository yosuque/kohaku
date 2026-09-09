"""Deterministic serialization: canonical JSON that is byte-compatible with JS JSON.stringify.

Port of the TS reference implementation (packages/spec-core/src/canonical-json.ts). Equal values always
produce the same byte sequence (the basis for hashing, cache keys, and diffs). To make hashes match
across languages, the following JS behaviors are reproduced exactly:

- Deep-sort object keys (UTF-16 code-unit order — identical to JS string comparison)
- Numbers use ECMAScript Number::toString (shortest round-trip representation + the exponential-notation
  switching rules)
- String escaping is identical to JSON.stringify (control characters as \\u00xx, lone surrogates as
  \\udxxx, other non-ASCII left as-is)
- UNDEFINED (the equivalent of JS undefined) is dropped as a dict value; array elements become null
- NaN / Infinity are rejected (the same fail-fast as the TS implementation)
"""

from __future__ import annotations

import hashlib
import math
from decimal import Decimal
from typing import Final


class _Undefined:
    """Sentinel equivalent to JS undefined (a singleton)."""

    _instance: _Undefined | None = None

    def __new__(cls) -> _Undefined:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "UNDEFINED"

    def __bool__(self) -> bool:
        return False


UNDEFINED: Final = _Undefined()
"""Equivalent to JS undefined. Used to distinguish "key absent" from "value is null"."""

# JS safe-integer range. Within this range, str() matches the JS numeric string (a fast path).
_MAX_SAFE_INTEGER: Final = 2**53

_STRING_ESCAPES: Final = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def canonical_stringify(value: object) -> str:
    """JSON-encode with object keys sorted at every depth (byte-compatible with the JS implementation)."""
    if isinstance(value, _Undefined):
        raise TypeError("canonical JSON cannot represent undefined at the top level")
    out: list[str] = []
    _write(value, out)
    return "".join(out)


def normalize_json_value(value: object) -> object:
    """Return a JSON value with keys sorted and UNDEFINED removed (the canonical form for display / storage)."""
    if isinstance(value, float) and not math.isfinite(value):
        raise TypeError(f"canonical JSON cannot represent a non-finite number: {value!r}")
    if isinstance(value, list):
        return [normalize_json_value(v) for v in value]
    if isinstance(value, dict):
        items = [(k, v) for k, v in value.items() if not isinstance(v, _Undefined)]
        items.sort(key=lambda kv: _canonical_sort_key(kv[0]))
        return {k: normalize_json_value(v) for k, v in items}
    return value


def sha256_hex(text: str) -> str:
    """sha256 hex digest. Lone surrogates are replaced with U+FFFD, the same as TextEncoder."""
    # The normal path is a single encode; only when lone surrogates exist do we fall back to pure-Python replacement (fast path).
    try:
        data = text.encode("utf-8")
    except UnicodeEncodeError:
        text = "".join("�" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in text)
        data = text.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def js_string(value: object) -> str:
    """Equivalent to JS String() (used for bind's three-way equality check and resolve_bound_ref substitution values)."""
    if value is None:
        return "null"
    if isinstance(value, _Undefined):
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return _format_int(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        return _format_double(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        # Array.prototype.toString: null / undefined elements become empty strings.
        return ",".join(
            "" if v is None or isinstance(v, _Undefined) else js_string(v) for v in value
        )
    if isinstance(value, dict):
        return "[object Object]"
    raise TypeError(f"js_string: not a JSON value: {type(value)!r}")


def _utf16_key(s: str) -> bytes:
    """Sort key as a UTF-16 code-unit sequence (same order as JS string comparison a < b)."""
    return s.encode("utf-16-be", "surrogatepass")


# Upper bound of an ES array index (the canonical numeric string for 0 <= n <= 2^32 - 2).
_MAX_ARRAY_INDEX: Final = 2**32 - 2


def _canonical_sort_key(s: str) -> tuple[int, int, bytes]:
    """Sort key that reproduces the JS property-enumeration order.

    The TS implementation sorts keys lexicographically and rebuilds the object, but JS objects enumerate
    array-index keys (canonical numeric strings such as "0", "2", "10") **first, in ascending numeric
    order** (ES OrdinaryOwnPropertyKeys). Hence the canonical form is "index keys in ascending numeric
    order, then the rest lexicographically (UTF-16 code-unit order)".
    """
    if s.isascii() and s.isdigit() and (s == "0" or not s.startswith("0")):
        n = int(s)
        if n <= _MAX_ARRAY_INDEX:
            return (0, n, b"")
    return (1, 0, _utf16_key(s))


def _write(value: object, out: list[str]) -> None:
    if value is None:
        out.append("null")
        return
    if isinstance(value, bool):  # check before int (bool is a subtype of int)
        out.append("true" if value else "false")
        return
    if isinstance(value, int):
        out.append(_format_int(value))
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            # NaN / Infinity collapse to null in JSON and would collide on the same hash as a genuine null, so reject them.
            raise TypeError(f"canonical JSON cannot represent a non-finite number: {value!r}")
        out.append(_format_double(value))
        return
    if isinstance(value, str):
        _write_string(value, out)
        return
    if isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i > 0:
                out.append(",")
            if isinstance(item, _Undefined):
                out.append("null")  # JSON.stringify([undefined]) === "[null]"
            else:
                _write(item, out)
        out.append("]")
        return
    if isinstance(value, dict):
        items: list[tuple[str, object]] = []
        for k, v in value.items():
            if not isinstance(k, str):
                raise TypeError(f"canonical JSON keys must be strings: {k!r}")
            if isinstance(v, _Undefined):
                continue  # keys with an undefined value are dropped (same as JSON.stringify)
            items.append((k, v))
        items.sort(key=lambda kv: _canonical_sort_key(kv[0]))
        out.append("{")
        for i, (k, v) in enumerate(items):
            if i > 0:
                out.append(",")
            _write_string(k, out)
            out.append(":")
            _write(v, out)
        out.append("}")
        return
    raise TypeError(f"canonical JSON cannot represent type: {type(value)!r}")


def _write_string(s: str, out: list[str]) -> None:
    parts = ['"']
    for ch in s:
        esc = _STRING_ESCAPES.get(ch)
        if esc is not None:
            parts.append(esc)
            continue
        cp = ord(ch)
        if cp < 0x20 or 0xD800 <= cp <= 0xDFFF:
            # Control characters and lone surrogates (well-formed JSON.stringify) become \uXXXX (lowercase hex).
            parts.append(f"\\u{cp:04x}")
        else:
            parts.append(ch)
    parts.append('"')
    out.append("".join(parts))


def _format_int(value: int) -> str:
    """Format an int as a JS number (IEEE754 double) string."""
    if -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
        return str(value)  # safe integers: str() matches JS (a fast path)
    try:
        return _format_double(float(value))
    except OverflowError:
        raise TypeError(f"canonical JSON cannot represent a non-finite number: {value!r}") from None


def _format_double(f: float) -> str:
    """Port of ECMAScript Number::toString (base 10, shortest round-trip).

    Takes the shortest round-trip digit string that repr(f) returns and reassembles it under the notation
    rules of ES spec 6.1.6.1.20 (normal notation up to 21 digits; exponential notation for >= 10^21 and
    <= 10^-7). Python and JS both use the "shortest correctly rounded" representation, so the digit string
    itself matches.
    """
    if f == 0.0:
        return "0"  # String(-0) === "0"
    if f < 0:
        return "-" + _format_double(-f)
    _, digits, exponent = Decimal(repr(f)).as_tuple()
    s = "".join(map(str, digits)).rstrip("0")
    assert isinstance(exponent, int)  # for finite values, as_tuple()'s exponent is always an int
    # value = int(s) * 10^(n - k) (s is a k-digit string)
    n = exponent + len(digits)
    k = len(s)
    if k <= n <= 21:
        return s + "0" * (n - k)
    if 0 < n <= 21:
        return s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + s
    e = n - 1
    exp_str = f"e+{e}" if e >= 0 else f"e-{-e}"
    if k == 1:
        return s + exp_str
    return s[0] + "." + s[1:] + exp_str
