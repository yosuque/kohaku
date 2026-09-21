"""L1/L2 generation prompts (port of TS prompt.ts).

The prompt bodies must be **character-for-character identical** with the TS implementation (so that
generatorVersion / cache generation separation carries the same meaning across languages). When changing them,
bump PROMPT_REVISION simultaneously with the TS side.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from kohaku.llm import PromptParts
from kohaku.registry import ResolvedCatalog, select_generation_types
from kohaku.spec import DataShape, Intent, JsonObject, UISpec, canonical_stringify

from .design_system import (
    DesignSystemGuide,
    design_kit_prompt_fragment,
    design_system_prompt_fragment,
)

PROMPT_REVISION = "12"
"""Revision of the L1/L2 prompts (in sync with TS's PROMPT_REVISION). Always bump it when changed.

"8": the version that introduced the design-system section (design_system_prompt_fragment) into
build_l2_prompt (paired with the lint's L2_RAW_COLOR). The output bytes when designSystem is unset are
identical to the previous version.
"9": the version that translated the repair-feedback strings (validation issues / L2 lint findings) to
English (part of making all runtime messages English).
"10": the version that translated the L1/L2 system prompts and dynamic sections to English and introduced
the output-language section (ComposePolicy.outputLanguage; default English). Generated user-visible text
now follows the specified output language regardless of the prompt's own language.
"11": the version that documents the sandbox's Worker-based execution model in L2_SYSTEM_PROMPT (generated
script now runs behind a DOM shim in a Web Worker rather than directly in the sandbox document): one
<style> in <head>, a single <script> just before </body> (concatenate multiple), and which DOM shim APIs
work normally versus which measurement APIs are only approximate or which globals do not exist at all
(paired with l2_lint's new L2_UNSAFE_MARKUP / L2_UNSUPPORTED_DOM checks). Python has no sandbox runtime of
its own (see the TS PROMPT_REVISION docstring and packages/spec-core/src/schema/sandbox-dom.ts's own note),
so this is a text-only mirror kept byte-identical with the TS prompt.
"12": the version that extends the design-system token vocabulary beyond colors (font / space / radius /
shadow / motion — DEFAULT_TOKEN_DESCRIPTIONS), replaces L2_SYSTEM_PROMPT's "keep the design simple" line
with a design brief, and adds the optional "Design kit" section (design_kit_prompt_fragment, paired with
the L2_UNKNOWN_CLASS lint — build_l2_prompt_static inserts it right after the design-system section, only
when design_system.kit is set). When ComposePolicy.designSystem is unspecified the L2 prompt still differs
from "11" (the brief), so this bump separates every cached L2 generation (same rule as TS's own note on
this revision).
"""


def default_generator_version(model_id: str) -> str:
    """Default value of generatorVersion. Composes the prompt version + model ID.

    A prompt revision (PROMPT_REVISION bump) or a model change separates the cacheKey, letting outputs be
    generation-managed by version while avoiding display flip-flop.
    """
    return f"p{PROMPT_REVISION}/{model_id}"


@dataclass(frozen=True)
class FewShotExample:
    """One example injected into few-shot. For the sake of the prompt budget it does not bring in provenance /
    dataVersion etc., placing only the normalized Intent and the skeleton of components / events."""

    canonical: str
    params: JsonObject
    spec: UISpec
    """Only components / events are used (other fields are not placed in the prompt)."""


L1_SYSTEM_PROMPT = "\n".join(
    [
        "You are the constrained generator of a UI Composition Service.",
        "Your only job is selecting catalog components and filling their typed props. Strictly follow these rules:",
        '- Always include exactly one layout component (layout.stack or layout.grid) with id "root", and reference the other components via children',
        "- Data may only be a $ref (query reference) permitted by the schema. Never write row data, aggregates, or numbers directly into props",
        "- Use only column names that exist in the presented column metadata (columns)",
        "- Add exactly one heading (text.heading) whose title concisely expresses the user's intent, written in the output language specified below",
        "- Tables where drill-down is natural may have a rowClick event (emit: intent.patch)",
        "- Output only JSON that fully conforms to the schema",
    ]
)


def catalog_prompt_fragment(
    catalog: ResolvedCatalog, include_types: Sequence[str] | None = None
) -> str:
    # Exclusion and narrowing are consolidated in select_generation_types (so the prompt's enumeration and
    # build_generation_schema's variants use the same vocabulary).
    included = set(select_generation_types(catalog, include_types))
    lines: list[str] = []
    for definition in catalog.list():
        if definition.type not in included:
            continue
        caps_parts = [
            f"data:{definition.capabilities.data}",
            f"children:{definition.capabilities.children}",
        ]
        if len(definition.capabilities.events) > 0:
            caps_parts.append(f"events:{'/'.join(definition.capabilities.events)}")
        caps = ", ".join(caps_parts)
        lines.append(f"- {definition.type}@{definition.version} ({caps}): {definition.description}")
    return "\n".join(lines)


def shape_prompt_fragment(shapes_by_ref: dict[str, DataShape]) -> str:
    if len(shapes_by_ref) == 0:
        return "(no column metadata)"
    lines: list[str] = []
    for ref, shape in shapes_by_ref.items():
        cols = ", ".join(
            f"{c.name}:{c.type}{f'({c.role})' if c.role is not None else ''}"
            for c in shape.columns
        )
        rows = f" approx. rows={shape.rowCountHint}" if shape.rowCountHint is not None else ""
        lines.append(f"- {ref}\n  columns: {cols}{rows}")
    return "\n".join(lines)


def repair_feedback_section(repair_feedback: list[str] | None) -> str:
    """The "problems in the previous generation" section text (including its own leading "\n\n"), shared by
    L1 and L2 (both tiers format repair feedback identically — port of TS's shared, exported
    `repairFeedbackSection`). Returns "" when repair_feedback is unset/empty, so
    `base + repair_feedback_section(fb)` is always exactly equivalent to the old per-tier "append if
    non-empty, else return base unchanged" logic.

    Not underscore-prefixed (unlike most of this module's helpers) so `generate_l1` in l1_generate.py — which
    already holds the static prefix built once outside the repair loop — can construct `PromptParts` directly
    as `PromptParts(cacheable=static_prompt, rest=repair_feedback_section(feedback))` instead of re-deriving
    `rest` through an `append_l1_repair_feedback("", feedback)` empty-string trick or re-running
    `build_l1_prompt_parts` (which would rebuild the static prefix on every attempt). This keeps the
    `cacheable + rest == prompt` invariant anchored to this one function (port of TS's prompt.ts change).
    """
    if repair_feedback is None or len(repair_feedback) == 0:
        return ""
    feedback_block = "\n".join(f"- {f}" for f in repair_feedback)
    return f"\n\n## Problems in the previous generation (must be fixed)\n{feedback_block}"


def build_l1_prompt_static(
    *,
    intent: Intent,
    catalog: ResolvedCatalog,
    refs: list[str],
    shapes_by_ref: dict[str, DataShape],
    include_types: Sequence[str] | None = None,
    few_shot: Sequence[FewShotExample] | None = None,
    output_language: str | None = None,
) -> str:
    """Builds every L1-prompt section except the trailing repair-feedback one (port of TS's
    `buildL1PromptStatic`). Depends only on intent/catalog/refs/shapes_by_ref/include_types/few_shot/
    output_language — all fixed for the lifetime of one generate_l1 call — so it is the natural "cacheable"
    half of `build_l1_prompt_parts`.
    """
    refs_block = "\n".join(f"- {r}" for r in refs) or "(none)"
    sections = [
        "## Canonical intent\n"
        + canonical_stringify({"canonical": intent.canonical, "params": intent.params}),
        f"## Available data references (only these URIs may be used as data.$ref)\n{refs_block}",
        f"## Data shape (column metadata)\n{shape_prompt_fragment(shapes_by_ref)}",
        f"## Component catalog\n{catalog_prompt_fragment(catalog, include_types)}",
    ]
    # few-shot goes "after the catalog, before the instructions". If empty/unset, add no section (output bytes unchanged).
    if few_shot is not None and len(few_shot) > 0:
        sections.append(few_shot_prompt_fragment(few_shot))
    lang = output_language if output_language is not None else "English"
    sections.append(
        f"## Output language\nWrite all user-visible text (the heading title, labels, annotations) in {lang}."
    )
    sections.append(
        "## Instructions\nCompose the UI that best expresses this intent as components / events."
    )
    return "\n\n".join(sections)


def append_l1_repair_feedback(base: str, repair_feedback: list[str] | None = None) -> str:
    """Appends the repair-feedback section to an L1 static prompt (port of TS's `appendL1RepairFeedback`)."""
    return base + repair_feedback_section(repair_feedback)


def build_l1_prompt(
    *,
    intent: Intent,
    catalog: ResolvedCatalog,
    refs: list[str],
    shapes_by_ref: dict[str, DataShape],
    include_types: Sequence[str] | None = None,
    few_shot: Sequence[FewShotExample] | None = None,
    output_language: str | None = None,
    repair_feedback: list[str] | None = None,
) -> str:
    return append_l1_repair_feedback(
        build_l1_prompt_static(
            intent=intent,
            catalog=catalog,
            refs=refs,
            shapes_by_ref=shapes_by_ref,
            include_types=include_types,
            few_shot=few_shot,
            output_language=output_language,
        ),
        repair_feedback,
    )


def build_l1_prompt_parts(
    *,
    intent: Intent,
    catalog: ResolvedCatalog,
    refs: list[str],
    shapes_by_ref: dict[str, DataShape],
    include_types: Sequence[str] | None = None,
    few_shot: Sequence[FewShotExample] | None = None,
    output_language: str | None = None,
    repair_feedback: list[str] | None = None,
) -> PromptParts:
    """Same content as `build_l1_prompt`, split at the boundary a prompt-caching-capable LlmPort adapter
    (kohaku.llm's `PromptParts`) can exploit — port of TS's `buildL1PromptParts`. See that function's doc for
    the full rationale (in short: `cacheable` is everything fixed across one L1 call's repair re-attempts,
    `rest` is only the trailing repair-feedback section). Invariant (always holds by construction):
    `cacheable + rest == build_l1_prompt(...)` with the same arguments.
    """
    cacheable = build_l1_prompt_static(
        intent=intent,
        catalog=catalog,
        refs=refs,
        shapes_by_ref=shapes_by_ref,
        include_types=include_types,
        few_shot=few_shot,
        output_language=output_language,
    )
    return PromptParts(cacheable=cacheable, rest=repair_feedback_section(repair_feedback))


def few_shot_prompt_fragment(examples: Sequence[FewShotExample]) -> str:
    """Prompt fragment for few-shot examples. For each example, deterministically arrange the normalized Intent
    and the skeleton of components / events via canonical_stringify."""
    body = "\n\n".join(
        canonical_stringify({"canonical": ex.canonical, "params": ex.params})
        + "\n"
        + canonical_stringify(
            {
                "components": [c.to_wire() for c in ex.spec.components],
                "events": [e.to_wire() for e in ex.spec.events],
            }
        )
        for ex in examples
    )
    return f"## Examples of good composition (follow this form; data must be $ref references)\n{body}"


L2_SYSTEM_PROMPT = "\n".join(
    [
        "You are the generator of a self-contained HTML widget that runs inside a sandbox. Rules:",
        "- The output is one complete HTML document itself (starting with <!DOCTYPE html> and ending with </html>). Do not wrap it in JSON, code fences, or prose, and do not add anything before or after",
        "- Put a display title (concise, in the output language specified below) in <head>'s <title> (the host uses it as the heading)",
        "- Never load external resources; CSP blocks them all",
        "- Write styles inline in <style> and scripts inline in <script>",
        "- Put exactly one <style> in <head> holding all CSS, and a single <script> just before </body> holding all JavaScript (if you would otherwise write more than one, concatenate them into one)",
        "- The script runs inside a Web Worker behind a DOM shim, not directly in the document: createElement / createElementNS / createTextNode / appendChild / textContent / innerHTML / className / classList / setAttribute / style.* / addEventListener (click / input / change / keydown) work as usual, but measurement (getBoundingClientRect / clientWidth / getComputedStyle) is only approximate — draw SVG with a fixed viewBox and width:100% rather than measuring pixel sizes. canvas / window.open / location / alert / localStorage / MutationObserver do not exist",
        "- Communication with the host is exactly these 4 window.kohaku APIs; no other method exists (calling one breaks with a TypeError):",
        "  1. window.kohaku.fetchData(ref): Promise — fetch data (pass ref exactly as the instructed URI string). Returns { columns: [{key,label?,type}], rows: [...], dataVersion }",
        "  2. window.kohaku.ready(): void — always call exactly once when rendering completes. Even when data fetching fails, render an error display and then call it (otherwise the host treats it as a timeout error)",
        "  3. window.kohaku.emit(eventName, payload): void — only when you want to forward a user interaction upstream",
        "  4. window.kohaku.onProps(callback): void — only when you want to subscribe to props updates from the parent",
        "- Always call the APIs directly in the form window.kohaku.methodName (no destructuring, no assigning to another variable, no writing method names that do not exist)",
        "- Basic script shape: an async function that fetchData → renders the DOM → finally calls window.kohaku.ready()",
        '- Write complete JavaScript with no syntax errors. In particular, never put a raw newline inside a string literal (\' or ") — use a template literal (`) when a multi-line string is needed',
        "- Always output the document completely through </html> (do not truncate)",
        "- Render only from the actual data (columns / rows) returned by fetchData. Do not fabricate dimensions or values that are not in the data. Fake rendering via Math.random() or fixed dummy values is forbidden (it breaks the same-data → same-display determinism)",
        "- If the columns lack what the requested breakdown (e.g. by region) needs, use the closest available column and add a short note inside the chart about what is missing",
        "- When drawing a chart, always draw tick values and axis labels (column name and unit) on both the X and Y axes. Compute positions from the actual data values (SVG is allowed)",
        "- Libraries such as D3 / Chart.js / jQuery do not exist and cannot be loaded. Use only the raw DOM API. Build SVG with document.createElementNS + setAttribute, or assemble a string and insert it via innerHTML (DOM elements have no .attr() method)",
        "- fetch / XMLHttpRequest / WebSocket / import are forbidden",
        "- Design brief (follow every point):",
        "  - one clear heading; secondary text in the muted color",
        "  - one consistent spacing scale throughout; use the design tokens or kit utilities when the prompt supplies them",
        "  - use the primary color for one emphasis at most; tone colors only when they carry meaning",
        "  - right-align numeric columns with tabular figures",
        "  - show empty / error / loading states as a notice, never a blank area",
        "  - never use fixed pixel widths — fill the container width",
        "  - never leave browser-default styling on tables, buttons or inputs",
    ]
)


def build_l2_prompt_static(
    *,
    intent: Intent,
    refs: list[str],
    shapes_by_ref: dict[str, DataShape],
    design_system: DesignSystemGuide | None = None,
    output_language: str | None = None,
) -> str:
    """Builds every L2-prompt section except the trailing repair-feedback one (port of TS's
    `buildL2PromptStatic`) — the L2 analogue of `build_l1_prompt_static`."""
    refs_block = "\n".join(f"- {r}" for r in refs) or "(none)"
    sections = [
        "## User request (canonical intent)\n"
        + canonical_stringify({"canonical": intent.canonical, "params": intent.params}),
        f"## Available data references\n{refs_block}",
        f"## Data shape\n{shape_prompt_fragment(shapes_by_ref)}",
    ]
    # The design-system section goes after the data shape and before the instructions (same position as TS). Output bytes unchanged when unset.
    if design_system is not None:
        sections.append(design_system_prompt_fragment(design_system))
        # The "Design kit" section directly follows the design-system section, only when a kit is set
        # (same position/condition as TS's buildL2PromptStatic).
        if design_system.kit is not None:
            sections.append(design_kit_prompt_fragment(design_system.kit))
    lang = output_language if output_language is not None else "English"
    sections.append(
        f"## Output language\nWrite all user-visible text (the <title>, labels, annotations) in {lang}."
    )
    sections.append(
        "## Instructions\nOutput a self-contained HTML widget (a complete HTML document) that fulfills this request."
    )
    return "\n\n".join(sections)


def append_l2_repair_feedback(base: str, repair_feedback: list[str] | None = None) -> str:
    """Appends the repair-feedback section to an L2 static prompt (port of TS's `appendL2RepairFeedback`)."""
    return base + repair_feedback_section(repair_feedback)


def build_l2_prompt(
    *,
    intent: Intent,
    refs: list[str],
    shapes_by_ref: dict[str, DataShape],
    design_system: DesignSystemGuide | None = None,
    output_language: str | None = None,
    repair_feedback: list[str] | None = None,
) -> str:
    return append_l2_repair_feedback(
        build_l2_prompt_static(
            intent=intent,
            refs=refs,
            shapes_by_ref=shapes_by_ref,
            design_system=design_system,
            output_language=output_language,
        ),
        repair_feedback,
    )


def build_l2_prompt_parts(
    *,
    intent: Intent,
    refs: list[str],
    shapes_by_ref: dict[str, DataShape],
    design_system: DesignSystemGuide | None = None,
    output_language: str | None = None,
    repair_feedback: list[str] | None = None,
) -> PromptParts:
    """Same content as `build_l2_prompt`, split at the L2 analogue of `build_l1_prompt_parts`'s boundary
    (port of TS's `buildL2PromptParts`). Invariant (always holds by construction):
    `cacheable + rest == build_l2_prompt(...)` with the same arguments.
    """
    cacheable = build_l2_prompt_static(
        intent=intent,
        refs=refs,
        shapes_by_ref=shapes_by_ref,
        design_system=design_system,
        output_language=output_language,
    )
    return PromptParts(cacheable=cacheable, rest=repair_feedback_section(repair_feedback))
