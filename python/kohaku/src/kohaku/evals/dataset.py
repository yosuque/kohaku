"""Distillation dataset export (port of TS packages/evals/src/dataset.ts).

Research on catalog-constrained declarative UI generation shows small models close much of the gap to
frontier models when trained/prompted on this kind of constrained output. A human-approved fixation
(L0, ``FixationRecord.pinnedSpec``) is the best teacher example available: it is exactly the
``{components, events}`` pair a distilled model should learn to reproduce for a given Intent, already
vetted by a human approver. Golden Specs (kohaku.evals's own regression fixtures) are the same shape of
teacher example without the human-approval step, useful as supplementary training data.

Exported as JSONL (one line per Spec) so it composes with the usual fine-tuning / distillation tooling
(streaming read, ``wc -l``, ``shuf``, ...) without a custom parser.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from kohaku.spec import ComponentNode, FixationRecord, Intent, UISpec, canonical_stringify

from .judge import ColumnMeta


@dataclass(frozen=True)
class DistillationRecord:
    """One distillation-dataset record: the LLM's declarative-generation input/output pair."""

    intent: dict[str, Any]
    """{"canonical": str, "params": dict[str, JsonValue]}."""
    refs: list[str]
    """The set of $refs the Spec's components read from (deduplicated, first-occurrence order)."""
    target: dict[str, Any]
    """The LLM's actual output range only: {"components": [...], "events": [...]}. Deliberately excludes
    kohaku (the protocol-envelope version), provenance, and dataVersion -- composer fills all three in
    around the model's output, so a distillation target that included them would teach a distilled model
    to imitate infra plumbing it never actually produces, rather than the declarative UI itself."""
    source: str
    """"fixation" | "golden"."""
    meta: dict[str, Any]
    """{"fixatedAt"?: str, "structureHash"?: str, "tenant"?: str, "catalogFingerprint"?: str}: all four keys
    are populated from the FixationRecord for source="fixation" (each omitted, not written as null, when the
    record predates that field -- Python's canonical_stringify writes None as JSON null rather than
    dropping the key the way TS's does with undefined, so the key must be left out explicitly to stay
    byte-compatible). Empty for source="golden" (golden Specs carry no tenant or fixation-time fingerprint)."""
    shape: list[ColumnMeta] | None = None
    """Optional column metadata for the Intent's data shape (from describe_shape; omitted when None)."""


def _refs_of(components: list[ComponentNode]) -> list[str]:
    """Extracts the set of $refs a Spec's components read from (deduplicated, first-occurrence order)."""
    seen: set[str] = set()
    out: list[str] = []
    for c in components:
        if c.data is not None and c.data.ref not in seen:
            seen.add(c.data.ref)
            out.append(c.data.ref)
    return out


def _record_to_json(record: DistillationRecord) -> dict[str, Any]:
    out: dict[str, Any] = {
        "intent": record.intent,
        "refs": record.refs,
        "target": record.target,
        "source": record.source,
        "meta": record.meta,
    }
    if record.shape is not None:
        out["shape"] = [
            {k: v for k, v in (("name", s.name), ("type", s.type), ("description", s.description)) if v is not None}
            for s in record.shape
        ]
    return out


def _fixation_meta(record: FixationRecord) -> dict[str, Any]:
    meta: dict[str, Any] = {"fixatedAt": record.fixatedAt, "structureHash": record.structureHash}
    if record.tenant is not None:
        meta["tenant"] = record.tenant
    if record.catalogFingerprint is not None:
        meta["catalogFingerprint"] = record.catalogFingerprint
    return meta


def _source_order(source: str) -> int:
    """Explicit tie-break order for entries that share the same sort key (see the sort below)."""
    return 0 if source == "fixation" else 1


def export_distillation_dataset(
    fixations: list[FixationRecord],
    golden: list[UISpec] | None = None,
    *,
    describe_shape: Callable[[Intent], list[ColumnMeta] | None] | None = None,
    tenant: str | None = None,
) -> str:
    """Exports human-approved fixations (and optionally golden Specs) as a JSONL distillation dataset: one
    canonical-JSON line per Spec.

    ``tenant``: restricts the export to fixations whose ``tenant`` matches this id (golden Specs carry no
    tenant and are always included regardless of this filter). ``None`` (the default) includes every tenant
    present in ``fixations`` in one JSONL -- the on-disk fixations snapshot legitimately holds records for
    several tenants side by side (keyed ``f"{tenant} {intentHash}"``; see storage-port.ts), so without this
    filter their approved structures land unmarked in one file unless ``meta["tenant"]`` is inspected per
    line.

    Deterministic order: entries are sorted by ``(intentHash, source)`` ascending (``FixationRecord.intentHash``
    for fixation entries, ``spec.intent.hash`` for golden entries; a "fixation" entry sorts before a "golden"
    entry that shares the same intentHash -- an explicit tie-break rather than relying on sort stability),
    and each line is serialized with canonical_stringify (deep key-sorted, byte-identical across
    languages). Re-running the export on the same input therefore reproduces byte-identical output -- this
    is also what pins the TS/Python cross-language golden (spec/scripts/generate-cross-language-fixtures.ts).

    Returns the empty string for empty input (no trailing newline); otherwise every line, including the
    last, ends with "\\n".
    """
    keyed: list[tuple[str, DistillationRecord]] = []

    selected_fixations = [r for r in fixations if r.tenant == tenant] if tenant is not None else fixations

    for record in selected_fixations:
        spec = record.pinnedSpec
        shape = describe_shape(spec.intent) if describe_shape is not None else None
        keyed.append(
            (
                record.intentHash,
                DistillationRecord(
                    intent={"canonical": spec.intent.canonical, "params": spec.intent.params},
                    refs=_refs_of(spec.components),
                    shape=shape,
                    target={
                        "components": [c.to_wire() for c in spec.components],
                        "events": [e.to_wire() for e in spec.events],
                    },
                    source="fixation",
                    meta=_fixation_meta(record),
                ),
            )
        )

    for spec in golden or []:
        shape = describe_shape(spec.intent) if describe_shape is not None else None
        keyed.append(
            (
                spec.intent.hash,
                DistillationRecord(
                    intent={"canonical": spec.intent.canonical, "params": spec.intent.params},
                    refs=_refs_of(spec.components),
                    shape=shape,
                    target={
                        "components": [c.to_wire() for c in spec.components],
                        "events": [e.to_wire() for e in spec.events],
                    },
                    source="golden",
                    meta={},
                ),
            )
        )

    keyed.sort(key=lambda kv: (kv[0], _source_order(kv[1].source)))
    lines = [canonical_stringify(_record_to_json(record)) for _, record in keyed]
    return "".join(f"{line}\n" for line in lines)
