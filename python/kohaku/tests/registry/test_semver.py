"""node-semver-compliant tests for semver_util.

The range-matching vectors port node-semver's range-include / range-exclude equivalents and check every
path of x-range / hyphen / comparison operators / whitespace AND / `||` OR / tilde / caret / prerelease rules.
"""

from __future__ import annotations

import pytest

from kohaku.registry import compare, gt, is_valid, parse_semver, satisfies

# --- Basics (parse / valid / compare / gt) ---


def test_is_valid_strict() -> None:
    assert is_valid("1.2.3")
    assert is_valid("1.2.3-alpha.1")
    assert is_valid("1.2.3+build.5")
    assert not is_valid("1.2")  # a partial version is invalid as a version
    assert not is_valid("v1.2.3")  # a v prefix is invalid as a version
    assert not is_valid("1.2.3.4")


def test_compare_and_gt() -> None:
    assert gt("2.0.0", "1.9.9")
    assert gt("1.2.3", "1.2.3-alpha")  # release > prerelease
    assert gt("1.2.3-beta", "1.2.3-alpha")
    assert gt("1.2.3-alpha.2", "1.2.3-alpha.1")
    assert not gt("1.0.0", "1.0.0")
    assert not gt("1.0.0-pre", "1.0.0")
    a, b = parse_semver("1.2.3"), parse_semver("1.2.3")
    assert a is not None and b is not None and compare(a, b) == 0


# --- Range match (satisfies == True). Equivalent to node-semver range-include. ---

_INCLUDE: list[tuple[str, str]] = [
    ("1.0.0 - 2.0.0", "1.2.3"),
    ("^1.2.3+build", "1.2.3"),
    ("^1.2.3+build", "1.3.0"),
    ("1.0.0", "1.0.0"),
    (">=*", "0.2.4"),
    ("", "1.0.0"),
    ("*", "1.2.3"),
    (">=1.0.0", "1.0.0"),
    (">=1.0.0", "1.0.1"),
    (">=1.0.0", "1.1.0"),
    (">1.0.0", "1.0.1"),
    (">1.0.0", "1.1.0"),
    ("<=2.0.0", "2.0.0"),
    ("<=2.0.0", "1.9999.9999"),
    ("<=2.0.0", "0.2.9"),
    ("<2.0.0", "1.9999.9999"),
    ("<2.0.0", "0.2.9"),
    (">= 1.0.0", "1.0.0"),
    (">=  1.0.0", "1.0.1"),
    ("<=  2.0.0", "0.2.9"),
    ("< 2.0.0", "1.9999.9999"),
    (">=0.1.97", "0.1.97"),
    ("0.1.20 || 1.2.4", "1.2.4"),
    (">=0.2.3 || <0.0.1", "0.0.0"),
    (">=0.2.3 || <0.0.1", "0.2.3"),
    (">=0.2.3 || <0.0.1", "0.2.4"),
    ("||", "1.3.4"),
    ("2.x.x", "2.1.3"),
    ("1.2.x", "1.2.3"),
    ("1.2.x || 2.x", "2.1.3"),
    ("1.2.x || 2.x", "1.2.3"),
    ("x", "1.2.3"),
    ("2.*.*", "2.1.3"),
    ("1.2.*", "1.2.3"),
    ("1.2.* || 2.*", "2.1.3"),
    ("2", "2.1.2"),
    ("2.3", "2.3.1"),
    ("~2.4", "2.4.0"),
    ("~2.4", "2.4.5"),
    ("~>3.2.1", "3.2.2"),
    ("~1", "1.2.3"),
    ("~>1", "1.2.3"),
    ("~> 1", "1.2.3"),
    ("~1.0", "1.0.2"),
    ("~ 1.0", "1.0.2"),
    ("~ 1.0.3", "1.0.12"),
    (">=1", "1.0.0"),
    (">= 1", "1.0.0"),
    ("<1.2", "1.1.1"),
    ("< 1.2", "1.1.1"),
    ("=0.7.x", "0.7.2"),
    ("<=0.7.x", "0.7.2"),
    (">=0.7.x", "0.7.2"),
    ("<=0.7.x", "0.6.2"),
    ("~1.2.1 >=1.2.3", "1.2.3"),
    ("~1.2.1 =1.2.3", "1.2.3"),
    ("~1.2.1 1.2.3", "1.2.3"),
    (">=1.2.1 1.2.3", "1.2.3"),
    ("1.2.3 >=1.2.1", "1.2.3"),
    ("^1.2.3", "1.8.1"),
    ("^0.1.2", "0.1.2"),
    ("^0.1", "0.1.2"),
    ("^0.0.1", "0.0.1"),
    ("^1.2", "1.4.2"),
    ("^1.2 ^1", "1.4.2"),
    ("1.2.3 - 3.4.5", "2.0.0"),
    ("1.2.3 - 3.4", "3.4.5"),
    ("~v0.5.4-pre", "0.5.5"),
    ("~v0.5.4-pre", "0.5.4"),
]

# --- Range non-match (satisfies == False). Equivalent to node-semver range-exclude. ---

_EXCLUDE: list[tuple[str, str]] = [
    ("1.0.0 - 2.0.0", "2.2.3"),
    ("1.0.0 - 2.0.0", "0.9.9"),
    ("^1.2.3", "1.2.2"),
    ("^1.2.3", "2.0.0"),
    ("^1.2.3", "3.4.5"),
    ("1.0.0", "1.0.1"),
    (">=1.0.0", "0.0.0"),
    (">1.0.0", "1.0.0"),
    ("<=2.0.0", "3.0.0"),
    ("<2.0.0", "2.0.0"),
    ("2.x.x", "1.1.3"),
    ("2.x.x", "3.1.3"),
    ("1.2.x", "1.3.3"),
    ("2.*.*", "1.1.3"),
    ("2", "1.1.1"),
    ("2", "3.1.1"),
    ("2.3", "2.4.1"),
    ("~2.4", "2.5.0"),
    ("~2.4", "2.3.9"),
    ("~1", "0.2.3"),
    ("~1", "2.2.3"),
    ("~1.0", "1.1.0"),
    ("~1.2.3", "1.3.0"),
    ("~1.2.3", "1.2.2"),
    ("<1.2", "1.2.0"),
    (">=1.2", "1.1.1"),
    ("=0.7.x", "0.8.2"),
    (">=0.7.x", "0.6.2"),
    ("<0.7.x", "0.7.2"),
    ("^0.0.1", "0.0.2"),
    ("^0.1.2", "0.2.0"),
]


@pytest.mark.parametrize(("rng", "version"), _INCLUDE)
def test_satisfies_include(rng: str, version: str) -> None:
    assert satisfies(version, rng), f"{version} should satisfy {rng!r}"


@pytest.mark.parametrize(("rng", "version"), _EXCLUDE)
def test_satisfies_exclude(rng: str, version: str) -> None:
    assert not satisfies(version, rng), f"{version} should NOT satisfy {rng!r}"


# --- prerelease rules (allowed only when a prerelease comparator with the same [M,m,p] exists). ---

_PRERELEASE_INCLUDE: list[tuple[str, str]] = [
    ("^1.2.3-alpha", "1.2.3-pre"),
    ("^1.2.0-alpha", "1.2.0-pre"),
    ("^1.2.3-alpha.3", "1.2.3-alpha.7"),
    (">=1.2.3-alpha", "1.2.3-beta"),
    ("1.2.3-pre.2", "1.2.3-pre.2"),
    (">=1.2.3-alpha <1.2.3-gamma", "1.2.3-beta"),
]

_PRERELEASE_EXCLUDE: list[tuple[str, str]] = [
    # a prerelease passes only when "that version has a prerelease comparator" (default behavior).
    ("*", "1.2.3-beta"),
    ("", "1.0.0-pre"),
    (">=1.2.3", "1.2.3-beta"),
    ("1.2.x", "1.2.3-beta"),
    ("2.x", "2.0.0-pre"),
    ("^1.2.3", "1.2.3-pre"),  # a prerelease smaller than the target version is rejected by the lower bound
    ("^1.2.3", "2.0.0-pre"),  # a next-major prerelease is rejected by the upper bound <2.0.0-0
    (">=1.2.3-alpha", "1.2.4-beta"),  # a prerelease of a different tuple is not allowed
]


@pytest.mark.parametrize(("rng", "version"), _PRERELEASE_INCLUDE)
def test_prerelease_include(rng: str, version: str) -> None:
    assert satisfies(version, rng), f"{version} should satisfy {rng!r}"


@pytest.mark.parametrize(("rng", "version"), _PRERELEASE_EXCLUDE)
def test_prerelease_exclude(rng: str, version: str) -> None:
    assert not satisfies(version, rng), f"{version} should NOT satisfy {rng!r}"


def test_invalid_version_never_satisfies() -> None:
    assert not satisfies("not-a-version", "*")
    assert not satisfies("1.2", ">=1.0.0")  # a partial version is invalid as a version


def test_invalid_range_is_fail_closed() -> None:
    """Containing an unparseable range piece falls the whole range to non-match, like node (fail-closed)."""
    # a single invalid clause -> non-match
    assert not satisfies("1.0.0", "garbage")
    assert not satisfies("1.0.0", ">=@@@")
    # if even one OR clause is invalid, the whole thing is non-match (do not return True even if another clause matches)
    assert not satisfies("1.0.0", "1.0.0 || garbage")
    assert not satisfies("1.0.0", "garbage || 1.0.0")
    assert not satisfies("1.5.0", ">=1.0.0 || not-a-range")
    # an OR whose clauses are all valid behaves as before (matches if it contains no invalid clause)
    assert satisfies("1.0.0", "1.0.0 || >=2.0.0")
    assert satisfies("2.5.0", "1.0.0 || >=2.0.0")
    assert not satisfies("1.5.0", "1.0.0 || >=2.0.0")
