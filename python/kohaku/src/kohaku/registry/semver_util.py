"""semver validation, comparison, and range matching (node-semver compliant).

The TS implementation uses npm's semver package (node-semver). The Python side implements the needed
valid / gt / satisfies to match node-semver's behavior.

Range matching is fully supported:
- x-range (`*` / `1` / `1.x` / `1.2.*`)
- hyphen range (`1.2.3 - 2.3.4`, with the same partial-specification boundaries as node)
- comparison operators (`>` / `>=` / `<` / `<=` / `=`; whitespace after the operator is allowed)
- tilde (`~1.2.3`) / caret (`^1.2.3`). The upper bound is `-0`-appended, same as node.
- whitespace-separated AND (`>=1.2.3 <2.0.0`) and `||` OR
- prerelease rules (a version with a prerelease matches only when a comparator with a prerelease and
  the same [major,minor,patch] is in the range; default = no includePrerelease)

Unknown/invalid range pieces fall to the "does not match" side (the safe side for authorization / downgrade).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$"
)


@dataclass(frozen=True)
class Semver:
    major: int
    minor: int
    patch: int
    prerelease: tuple[str, ...]


def parse_semver(version: str) -> Semver | None:
    m = _SEMVER_RE.match(version)
    if m is None:
        return None
    pre = tuple(m.group(4).split(".")) if m.group(4) else ()
    return Semver(int(m.group(1)), int(m.group(2)), int(m.group(3)), pre)


def is_valid(version: str) -> bool:
    return parse_semver(version) is not None


def _compare_prerelease(a: tuple[str, ...], b: tuple[str, ...]) -> int:
    """semver spec: no-prerelease > has-prerelease. Identifiers compare numerically when numeric; mixed = numeric < string."""
    if not a and not b:
        return 0
    if not a:
        return 1
    if not b:
        return -1
    for x, y in zip(a, b, strict=False):
        x_num, y_num = x.isdigit(), y.isdigit()
        if x_num and y_num:
            if int(x) != int(y):
                return -1 if int(x) < int(y) else 1
        elif x_num != y_num:
            return -1 if x_num else 1
        elif x != y:
            return -1 if x < y else 1
    return -1 if len(a) < len(b) else (1 if len(a) > len(b) else 0)


def compare(a: Semver, b: Semver) -> int:
    for x, y in ((a.major, b.major), (a.minor, b.minor), (a.patch, b.patch)):
        if x != y:
            return -1 if x < y else 1
    return _compare_prerelease(a.prerelease, b.prerelease)


def gt(a: str, b: str) -> bool:
    """Equivalent to semver.gt. Invalid versions are False (assuming the caller checks with is_valid first)."""
    pa, pb = parse_semver(a), parse_semver(b)
    if pa is None or pb is None:
        return False
    return compare(pa, pb) > 0


# ---------------------------------------------------------------------------
# Range matching (node-semver)
# ---------------------------------------------------------------------------

# The xrange identifier (numeric or wildcard) and the patterns for partial version / prerelease / build.
_XID = r"x|X|\*|0|[1-9]\d*"
_PRE = (
    r"(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)"
    r"(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*"
)
_BUILD = r"[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*"

# A partial version (for detecting both sides of a hyphen range; non-capturing).
_PARTIAL_STR = (
    r"v?(?:" + _XID + r")"
    r"(?:\.(?:" + _XID + r")"
    r"(?:\.(?:" + _XID + r")"
    r"(?:-(?:" + _PRE + r"))?"
    r"(?:\+(?:" + _BUILD + r"))?"
    r")?)?"
)

# Decompose a single partial version (capturing M / m / p / prerelease).
_XPARTIAL_RE = re.compile(
    r"^v?(" + _XID + r")"
    r"(?:\.(" + _XID + r")"
    r"(?:\.(" + _XID + r")"
    r"(?:-(" + _PRE + r"))?"
    r"(?:\+(?:" + _BUILD + r"))?"
    r")?)?$"
)

# A single comparator (operator + partial version). Assumes whitespace after the operator was already removed by _collapse_op_space.
_COMP_RE = re.compile(
    r"^(~>?|\^|>=|<=|>|<|=)?\s*"
    r"v?(" + _XID + r")"
    r"(?:\.(" + _XID + r")"
    r"(?:\.(" + _XID + r")"
    r"(?:-(" + _PRE + r"))?"
    r"(?:\+(?:" + _BUILD + r"))?"
    r")?)?$"
)

# A hyphen range (`<partial> - <partial>`). Captures each whole side.
_HYPHEN_RE = re.compile(r"(" + _PARTIAL_STR + r")\s+-\s+(" + _PARTIAL_STR + r")")

# Remove whitespace immediately after the operator to make one token (`>= 1.2.3` -> `>=1.2.3`).
_OP_SPACE_RE = re.compile(r"(~>?|\^|>=|<=|>|<|=)\s+")


@dataclass(frozen=True)
class _Comparator:
    """A single comparator. op="" means ANY (any version) and semver is None."""

    op: str  # "<" / "<=" / ">" / ">=" / "=" / "" (ANY)
    semver: Semver | None


_ANY = _Comparator("", None)
# node's "matches nothing" comparator (<0.0.0-0).
_MATCH_NOTHING = _Comparator("<", Semver(0, 0, 0, ("0",)))
_PRE0: tuple[str, ...] = ("0",)


def _is_x(v: str | None) -> bool:
    """True if missing (None) or a wildcard (x/X/*)."""
    return v is None or v in ("x", "X", "*")


def _cmp(op: str, major: int, minor: int, patch: int, pre: tuple[str, ...] = ()) -> _Comparator:
    return _Comparator(op, Semver(major, minor, patch, pre))


def _partial_lower(part: str) -> str:
    """Turn a hyphen range's lower bound into a comparator string using the same rules as node."""
    m = _XPARTIAL_RE.match(part)
    assert m is not None  # a piece that _HYPHEN_RE matched via _PARTIAL_STR, so it always parses
    major, minor, patch, pre = m.group(1), m.group(2), m.group(3), m.group(4)
    if _is_x(major):
        return ""
    if _is_x(minor):
        return f">={int(major)}.0.0"
    if _is_x(patch):
        return f">={int(major)}.{int(minor)}.0"
    if pre:
        return f">={major}.{minor}.{patch}-{pre}"
    return f">={major}.{minor}.{patch}"


def _partial_upper(part: str) -> str:
    """Turn a hyphen range's upper bound into a comparator string using the same rules as node (a partial spec is just before the next version)."""
    m = _XPARTIAL_RE.match(part)
    assert m is not None
    major, minor, patch, pre = m.group(1), m.group(2), m.group(3), m.group(4)
    if _is_x(major):
        return ""
    if _is_x(minor):
        return f"<{int(major) + 1}.0.0-0"
    if _is_x(patch):
        return f"<{int(major)}.{int(minor) + 1}.0-0"
    if pre:
        return f"<={major}.{minor}.{patch}-{pre}"
    return f"<={major}.{minor}.{patch}"


def _hyphen_replace(s: str) -> str:
    """Expand `a - b` into `>=a <=b` (with node's boundary rules for partial specs)."""

    def repl(mo: re.Match[str]) -> str:
        return (_partial_lower(mo.group(1)) + " " + _partial_upper(mo.group(2))).strip()

    return _HYPHEN_RE.sub(repl, s)


def _expand_comparator(token: str) -> list[_Comparator] | None:
    """Expand one token into 0-2 primitive comparators (tilde / caret / x-range / operator).

    Equivalent to node-semver's replaceTilde / replaceCaret / replaceXRange. None if unparseable.
    """
    m = _COMP_RE.match(token)
    if m is None:
        return None
    op = m.group(1) or ""
    if op == "~>":
        op = "~"
    raw_major, raw_minor, raw_patch, pre_str = m.group(2), m.group(3), m.group(4), m.group(5)
    x_major = _is_x(raw_major)
    x_minor = x_major or _is_x(raw_minor)
    x_patch = x_minor or _is_x(raw_patch)
    major = 0 if x_major else int(raw_major)
    minor = 0 if _is_x(raw_minor) else int(raw_minor)
    patch = 0 if _is_x(raw_patch) else int(raw_patch)
    pre = tuple(pre_str.split(".")) if pre_str else ()

    if op == "~":
        if x_major:
            return [_ANY]
        if x_minor:
            return [_cmp(">=", major, 0, 0), _cmp("<", major + 1, 0, 0, _PRE0)]
        if x_patch:
            return [_cmp(">=", major, minor, 0), _cmp("<", major, minor + 1, 0, _PRE0)]
        return [_cmp(">=", major, minor, patch, pre), _cmp("<", major, minor + 1, 0, _PRE0)]

    if op == "^":
        if x_major:
            return [_ANY]
        if x_minor:
            return [_cmp(">=", major, 0, 0), _cmp("<", major + 1, 0, 0, _PRE0)]
        if x_patch:
            if major == 0:
                return [_cmp(">=", major, minor, 0), _cmp("<", major, minor + 1, 0, _PRE0)]
            return [_cmp(">=", major, minor, 0), _cmp("<", major + 1, 0, 0, _PRE0)]
        lower = _cmp(">=", major, minor, patch, pre)
        if major == 0:
            if minor == 0:
                upper = _cmp("<", major, minor, patch + 1, _PRE0)
            else:
                upper = _cmp("<", major, minor + 1, 0, _PRE0)
        else:
            upper = _cmp("<", major + 1, 0, 0, _PRE0)
        return [lower, upper]

    # x-range / operator-prefixed partial version
    any_x = x_major or x_minor or x_patch
    if op == "=" and any_x:
        op = ""
    if x_major:
        # major is a wildcard: `>`/`<` match nothing, and the rest (""/">="/"<=") are any.
        if op in (">", "<"):
            return [_MATCH_NOTHING]
        return [_ANY]
    if op and any_x:
        # partial spec + operator: normalize to the next-version boundary, same as node's replaceXRange.
        upper_minor = 0 if x_minor else minor
        if op == ">":
            if x_minor:
                return [_cmp(">=", major + 1, 0, 0)]
            return [_cmp(">=", major, minor + 1, 0)]
        if op == "<=":
            if x_minor:
                return [_cmp("<", major + 1, 0, 0, _PRE0)]
            return [_cmp("<", major, minor + 1, 0, _PRE0)]
        if op == "<":
            return [_cmp("<", major, upper_minor, 0, _PRE0)]
        # op == ">="
        return [_cmp(">=", major, upper_minor, 0)]
    if x_minor:
        return [_cmp(">=", major, 0, 0), _cmp("<", major + 1, 0, 0)]
    if x_patch:
        return [_cmp(">=", major, minor, 0), _cmp("<", major, minor + 1, 0)]
    # Fully specified (no operator means an exact match `=`)
    return [_cmp(op if op else "=", major, minor, patch, pre)]


def _parse_comparator_set(part: str) -> list[_Comparator] | None:
    """Turn a whitespace-separated AND into a list of primitive comparators. None if any token is unparseable (a parse failure).

    node-semver throws at Range construction if it contains an invalid comparator. Here we return None so
    the caller (_parse_range) can fall the whole range to non-match.
    """
    part = part.strip()
    if part == "":
        return [_ANY]
    part = _hyphen_replace(part)
    part = _OP_SPACE_RE.sub(r"\1", part)
    tokens = part.split()
    if not tokens:
        return [_ANY]
    comparators: list[_Comparator] = []
    for token in tokens:
        expanded = _expand_comparator(token)
        if expanded is None:
            return None
        comparators.extend(expanded)
    return comparators if comparators else [_ANY]


def _parse_range(version_range: str) -> list[list[_Comparator]] | None:
    """Turn a range string into an OR (`||`) of AND (whitespace) comparator sets.

    If even one clause is unparseable, return None and fall the whole range to non-match (fail-closed),
    same as node-semver's "Range construction throws -> satisfies false".
    """
    sets: list[list[_Comparator]] = []
    for part in version_range.split("||"):
        comps = _parse_comparator_set(part)
        if comps is None:
            return None
        sets.append(comps)
    return sets


def _comparator_test(comp: _Comparator, v: Semver) -> bool:
    if comp.op == "" or comp.semver is None:
        return True  # ANY
    c = compare(v, comp.semver)
    if comp.op == ">":
        return c > 0
    if comp.op == ">=":
        return c >= 0
    if comp.op == "<":
        return c < 0
    if comp.op == "<=":
        return c <= 0
    return c == 0  # "="


def _set_test(comparators: list[_Comparator], v: Semver) -> bool:
    """Decide an AND set. A prerelease version requires "a comparator with a prerelease and the same tuple"."""
    for comp in comparators:
        if not _comparator_test(comp, v):
            return False
    if v.prerelease:
        for comp in comparators:
            s = comp.semver
            if (
                s is not None
                and s.prerelease
                and s.major == v.major
                and s.minor == v.minor
                and s.patch == v.patch
            ):
                return True
        return False
    return True


def satisfies(version: str, version_range: str) -> bool:
    """Whether version satisfies the node-semver range version_range."""
    v = parse_semver(version)
    if v is None:
        return False
    try:
        sets = _parse_range(version_range.strip())
    except (ValueError, re.error):
        return False  # an invalid range falls to the safe side (non-match)
    if sets is None:
        return False  # if even one clause is unparseable, the whole range is non-match (fail-closed)
    return any(_set_test(comps, v) for comps in sets)
