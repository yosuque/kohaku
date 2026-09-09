"""Golden Spec regression (port of TS packages/evals/src/golden.ts).

A regression test of input Intent → expected Spec. Variance in the LLM output is absorbed by normalization:
- mask provenance / intent.hash / dataVersion / refVersions (default)
- normalize component IDs to DFS position-based (references in events / children are renamed consistently)
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal

from kohaku.composer import ComposeContext, ComposeInput, compose
from kohaku.spec import (
    ROOT_COMPONENT_ID,
    UISpec,
    canonical_stringify,
    order_components,
)

IgnorePath = Literal["provenance", "intent.hash", "dataVersion", "refVersions"]

_DEFAULT_IGNORE: tuple[IgnorePath, ...] = (
    "provenance",
    "intent.hash",
    "dataVersion",
    "refVersions",
)


@dataclass(frozen=True)
class MatchOptions:
    ignore: tuple[IgnorePath, ...] | None = None
    """Top-level paths to mask (default: provenance, intent.hash, dataVersion, refVersions)."""
    positional_ids: bool | None = None
    """Normalize IDs to position-based (c0, c1, …) before comparing (default True)."""


@dataclass(frozen=True)
class GoldenCase:
    name: str
    input: ComposeInput
    expected: UISpec
    match: MatchOptions | None = None


@dataclass(frozen=True)
class GoldenCaseResult:
    name: str
    pass_: bool
    duration_ms: float
    expected: str | None = None
    actual: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class GoldenReport:
    pass_: bool
    cases: list[GoldenCaseResult]


def normalize_for_match(spec: UISpec, options: MatchOptions | None = None) -> str:
    """Return a canonical-form string for comparison (variance absorbed). Also usable for test diff display."""
    opts = options if options is not None else MatchOptions()
    ignore = opts.ignore if opts.ignore is not None else _DEFAULT_IGNORE
    components = [c.to_wire() for c in spec.components]
    events = [e.to_wire() for e in spec.events]

    if opts.positional_ids if opts.positional_ids is not None else True:
        ordered = order_components(spec.components)
        rename: dict[str, str] = {}
        for i, c in enumerate(ordered):
            rename[c.id] = ROOT_COMPONENT_ID if c.id == ROOT_COMPONENT_ID else f"c{i}"
        components = []
        for c in ordered:
            node = c.to_wire()
            node["id"] = rename[c.id]
            if c.children is not None:
                node["children"] = [rename.get(x, x) for x in c.children]
            components.append(node)
        renamed_events: list[dict[str, Any]] = []
        for e in spec.events:
            wire = e.to_wire()
            dot = wire["on"].index(".")
            target = rename.get(wire["on"][:dot])
            if target is not None:
                wire["on"] = f"{target}{wire['on'][dot:]}"
            renamed_events.append(wire)
        events = renamed_events

    intent: dict[str, Any] = {
        "canonical": spec.intent.canonical,
        "params": spec.intent.params,
    }
    if "intent.hash" not in ignore:
        intent["hash"] = spec.intent.hash

    projected: dict[str, Any] = {
        "kohaku": spec.kohaku,
        "intent": intent,
        "components": components,
        "events": events,
    }
    if "dataVersion" not in ignore:
        projected["dataVersion"] = spec.dataVersion
    if "refVersions" not in ignore and spec.refVersions is not None:
        projected["refVersions"] = spec.refVersions
    if "provenance" not in ignore:
        projected["provenance"] = spec.provenance.to_wire()
    return canonical_stringify(projected)


def specs_match(actual: UISpec, expected: UISpec, options: MatchOptions | None = None) -> bool:
    return normalize_for_match(actual, options) == normalize_for_match(expected, options)


async def run_golden(cases: list[GoldenCase], ctx: ComposeContext) -> GoldenReport:
    """Run the Golden cases through the composer and verify them."""
    results: list[GoldenCaseResult] = []
    for c in cases:
        started_at = time.monotonic()
        try:
            result = await compose(c.input, ctx)
            actual = normalize_for_match(result.spec, c.match)
            expected = normalize_for_match(c.expected, c.match)
            match = actual == expected
            results.append(
                GoldenCaseResult(
                    name=c.name,
                    pass_=match,
                    actual=None if match else actual,
                    expected=None if match else expected,
                    duration_ms=(time.monotonic() - started_at) * 1000,
                )
            )
        except Exception as e:  # noqa: BLE001
            results.append(
                GoldenCaseResult(
                    name=c.name,
                    pass_=False,
                    error=str(e),
                    duration_ms=(time.monotonic() - started_at) * 1000,
                )
            )
    return GoldenReport(pass_=all(r.pass_ for r in results), cases=results)
