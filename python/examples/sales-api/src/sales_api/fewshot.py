"""A source that maps fixations (L0) to good few-shot examples (port of TS: apps/sample-api/src/fewshot.ts).

Fixated Specs are a population "recognized as good compositions through human review", so they are used as examples
for L1 generation. list_fixations() is stably sorted by **preferring canonical match -> ascending intentHash**, and
only the components / events of the top 2 pinnedSpecs are placed as examples.

Determinism: for the same input (the same fixation set, the same intent) it always returns the same order and the same
2 items. This determinism is the premise of cache consistency (same intent -> same prompt -> same generation).
"""

from __future__ import annotations

from collections.abc import Sequence

from kohaku.composer import FewShotExample, FewShotPolicy
from kohaku.spec import FixationRecord, Intent, StoragePort


def create_fixation_fewshot(storage: StoragePort) -> FewShotPolicy:
    """Creates a FewShotPolicy that deterministically supplies good examples from StoragePort's fixation set."""

    async def examples(intent: Intent) -> list[FewShotExample]:
        fixations = await storage.list_fixations()
        selected = _sort_fixations(fixations, intent.canonical)[:2]
        return [
            FewShotExample(
                canonical=f.pinnedSpec.intent.canonical,
                params=f.pinnedSpec.intent.params,
                # Only the spec's components / events are used (the contract of FewShotExample).
                spec=f.pinnedSpec,
            )
            for f in selected
        ]

    return FewShotPolicy(examples=examples)


def _sort_fixations(
    fixations: Sequence[FixationRecord], canonical: str
) -> list[FixationRecord]:
    """Fixations matching the given canonical first, then ascending intentHash (unique, derived from sha256)."""
    return sorted(
        fixations, key=lambda f: (0 if f.canonical == canonical else 1, f.intentHash)
    )


__all__ = ["create_fixation_fewshot"]
