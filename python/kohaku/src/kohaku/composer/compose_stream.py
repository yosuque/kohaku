"""Streaming version of compose (port of TS compose-stream.ts. spec/SPEC.md §6.1.1 [Draft]).

The slow path (L1/L2) returns a skeleton (ui.loading) immediately, and during generation returns
**patches to a provisional Spec** built from the LLM's partial output incrementally (only when stream_object is
implemented; 0..N times), converging with a patch to the final form after generation completes. The fast path
(cache hit / L0 / fixation short-circuit) emits no skeleton and completes in a single event with final=True.

The generation body, single-flight, and cache store are identical to compose() (run_generation is shared).
The skeleton and provisional Specs are never cached, lineage-recorded, or made fixation candidates (only the
generation body calls put_spec_cache; the MUST NOT of spec/SPEC.md §6.1.1). single-flight followers do not
receive provisional patches. observer.onComposed is called exactly once on the final Spec (inside finish).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from typing import Any, Literal

from kohaku.llm import supports_streaming
from kohaku.registry import GenerationSchema, build_generation_schema
from kohaku.spec import SPEC_VERSION, Intent, SpecPatch, UISpec, diff_spec

from .compose import (
    COMPOSER_ID,
    ComposeInput,
    ComposeOptions,
    ComposeResult,
    PreparedCompose,
    finish,
    negotiate_spec,
    post_and_validate,
    prepare_compose,
    report_compose_error,
    run_generation,
    to_trace_input,
)
from .context import ComposeContext, ComposeErrorContext, ResolvedRefs, resolve_tier_llm
from .errors import ComposeError


@dataclass(frozen=True)
class StreamSpecEvent:
    """The initial Spec (with negotiate applied). final=True means single-event completion (cache hit / L0).

    refs is all resolved QueryHandle URIs (for the host's capability issuance).
    """

    spec: UISpec
    final: bool
    refs: list[str]
    kind: Literal["spec"] = "spec"


@dataclass(frozen=True)
class StreamPatchEvent:
    """Diff from skeleton → final form. spec is the final form with the patch applied (obviating the host's re-application)."""

    patch: SpecPatch
    spec: UISpec
    kind: Literal["patch"] = "patch"


@dataclass(frozen=True)
class StreamDoneEvent:
    """Terminal. result is the same ComposeResult as non-stream compose."""

    result: ComposeResult
    kind: Literal["done"] = "done"


type ComposeStreamEvent = StreamSpecEvent | StreamPatchEvent | StreamDoneEvent


async def compose_stream(
    input: ComposeInput, base_ctx: ComposeContext, opts: ComposeOptions | None = None
) -> AsyncIterator[ComposeStreamEvent]:
    """Errors are raised (same as compose; no error variant is created among the events).

    An L1/L2 failure after the skeleton is emitted arrives as a "patch to the fallback Spec", because
    build_fallback_spec returns a normal Spec.
    """
    opts = opts or ComposeOptions()
    # Like compose(), swap to the tenant's catalog and the session's policy exactly once, then layer the
    # caller's policy_override on top (before prepare_compose for cache-key correctness).
    ctx = (
        base_ctx.with_tenant_catalog(opts.session.tenant if opts.session is not None else None)
        .with_session_policy(opts.session)
        .with_policy_override(opts.policy_override)
    )
    try:
        prepared = await prepare_compose(input, ctx, opts)
        refs = prepared.refs.uris

        # 1. Cache hit: complete in a single event with final=True, delivering the negotiate-applied Spec.
        if prepared.cached is not None:
            spec, trace = prepared.cached
            result = finish(spec, trace, ctx)
            yield StreamSpecEvent(spec=result.spec, final=True, refs=refs)
            yield StreamDoneEvent(result=result)
            return

        # 2. An L0 fixed-Spec match also completes in a single final=True event after generation (no skeleton emitted).
        #    fixedSpecs.lookup is deterministic for the intent, so its result matches the re-lookup inside run_generation.
        fixed = (
            await prepared.policy.fixedSpecs.lookup(prepared.intent)
            if prepared.policy.fixedSpecs is not None
            else None
        )
        if fixed is not None:
            outcome = await run_generation(prepared, ctx)
            result = finish(outcome.spec, outcome.trace, ctx)
            yield StreamSpecEvent(spec=result.spec, final=True, refs=refs)
            yield StreamDoneEvent(result=result)
            return

        # 3. L1/L2 path: return the skeleton (root + ui.loading) immediately. dataVersion / refVersions are
        #    resolved values, identical to the final form → the diff stays small.
        skeleton = negotiate_spec(_build_skeleton_spec(prepared.intent, prepared.refs, ctx), ctx)
        yield StreamSpecEvent(spec=skeleton, final=False, refs=refs)

        # 4. Deliver the in-progress partial output (LlmPort.stream_object) incrementally as provisional patches.
        #    Conflating (keep only the latest partial): when consumption cannot keep up with generation, skip intermediate forms.
        #    When stream_object is unimplemented / on the prompt-JSON fallback, no partial arrives and it stays
        #    just "skeleton → final patch" as before (behavior-compatible).
        state = _ConflatingState()
        leader_prepared = prepared
        # Streaming is L1-only (see generate_l1's on_draft_partial contract), so the capability check must
        # read the tier's actually-resolved port (ComposeContext.llmByTier) rather than the base ctx.llm —
        # otherwise a compose with llmByTier.L1 set to a stream_object-capable port while the base llm is
        # not (or vice versa) would decide the fast-path wrong here even though generate_l1 itself resolves
        # correctly.
        if supports_streaming(resolve_tier_llm(ctx, "L1")):
            leader_prepared = replace(prepared, on_draft_partial=state.on_partial)

        # Run generation (single-flight) concurrently without awaiting, receiving only completion notification (the result/exception is handled by the later await).
        gen_task = asyncio.ensure_future(run_generation(leader_prepared, ctx))
        gen_task.add_done_callback(state.on_generation_done)

        # The decode used to build provisional Specs (same composition as the generation schema). Built only when the first partial arrives.
        # The loop is "always process a pending partial, and break only when generation is done AND nothing is pending".
        # It does not depend on asyncio's scheduling order and does not miss the last conflated partial even if
        # generation completes first (replacing TS's microtask-ordering guarantee with an explicit drain).
        generation: GenerationSchema | None = None
        last_spec = skeleton
        while True:
            if not state.has_partial:
                if state.generation_done:
                    break
                await state.wake.wait()
                state.wake.clear()
                continue
            raw = state.take_partial()
            if generation is None:
                include_types = (
                    ctx.policy.selectComponents(prepared.intent, ctx.catalog)
                    if ctx.policy is not None and ctx.policy.selectComponents is not None
                    else None
                )
                generation = build_generation_schema(ctx.catalog, prepared.refs.uris, include_types)
            provisional = _build_provisional_spec(raw, prepared, ctx, generation)
            if provisional is None:
                continue
            patch = diff_spec(last_spec, provisional)
            if _is_empty_patch(patch):
                continue
            yield StreamPatchEvent(patch=patch, spec=provisional)
            last_spec = provisional

        # 5. Finalize: patch to the final Spec → done (same as before; a diff from the provisional form).
        #    The final patch is sent unconditionally (always emit exactly one before done, even if empty). An exception is re-raised by await gen_task.
        outcome = await gen_task
        result = finish(outcome.spec, outcome.trace, ctx)
        patch = diff_spec(last_spec, result.spec)
        yield StreamPatchEvent(patch=patch, spec=result.spec)
        yield StreamDoneEvent(result=result)
    except BaseException as e:
        # Notify the observer hook of a hard failure (whether before or after the skeleton was emitted) and re-raise.
        report_compose_error(ctx, ComposeErrorContext(phase="hard", input=to_trace_input(input)), e)
        raise


def _build_skeleton_spec(intent: Intent, refs: ResolvedRefs, ctx: ComposeContext) -> UISpec:
    """Deterministically builds the skeleton Spec for the streaming initial display.

    Two nodes: root (layout.stack) + ui.loading. Passing through post_and_validate aligns component-version
    filling and props-default filling (such as ui.loading's label) with the generated Spec.
    """
    raw = UISpec.model_validate(
        {
            "kohaku": SPEC_VERSION,
            "intent": intent.to_wire(),
            "dataVersion": refs.dataVersion,
            **({"refVersions": refs.versionsByRef} if len(refs.versionsByRef) > 0 else {}),
            "components": [
                {
                    "id": "root",
                    "type": "layout.stack",
                    "props": {"direction": "vertical", "gap": "md"},
                    "children": ["loading1"],
                },
                {"id": "loading1", "type": "ui.loading", "props": {}},
            ],
            "events": [],
            "provenance": {"tier": "L1", "composedBy": COMPOSER_ID, "cache": "miss"},
        }
    )
    return post_and_validate(raw, refs, ctx)


class _ConflatingState:
    """Conflating state for incremental streaming (one latest partial + a done flag + a wake event).

    Replaces TS's wake/notify (recreating a pending promise) with an asyncio.Event. on_partial stores and sets
    the partial synchronously from within the generation task, and the consumer loop receives it via wake.wait().
    Because only the latest value is kept, intermediate forms are skipped when consumption cannot keep up (conflating).
    """

    def __init__(self) -> None:
        self._latest: object = None
        self.has_partial = False
        self.generation_done = False
        self.wake = asyncio.Event()

    def on_partial(self, raw: object) -> None:
        self._latest = raw
        self.has_partial = True
        self.wake.set()

    def take_partial(self) -> object:
        self.has_partial = False
        return self._latest

    def on_generation_done(self, task: object) -> None:
        self.generation_done = True
        self.wake.set()
        # Prevent the orphan task's "Task exception was never retrieved" warning.
        # When cancelled, do not call exception() because it re-raises CancelledError
        # (same intent as host_mcp/server.py:_spawn_fixation_task, plus a guard).
        if isinstance(task, asyncio.Future) and not task.cancelled():
            task.exception()


def _build_provisional_spec(
    raw: object, prepared: PreparedCompose, ctx: ComposeContext, generation: GenerationSchema
) -> UISpec | None:
    """Builds a provisional Spec from the LLM's cumulative partial draft (parse & heal). None (skip) at stages where it cannot be built.

    Breakdown of heal:
    - Skip an unfinished form that decode (the generation schema's defensive conversion) throws on (wait for the next partial).
    - Validate against the catalog per component and keep **only completed components** (trailing in-progress components fall off naturally).
    - Prune `children` to already-arrived ids (an unarrived reference would fail structural validation).
    - Do not place `events` on the provisional form (do not guarantee payload-template reference consistency in an in-progress form; it arrives in the final patch).
    - Finally run the usual deterministic post-processing + structural validation (post_and_validate) + negotiate, skipping stages that do not pass.

    The provisional Spec is out of scope for caching/recording/fixation (the caller just streams it as events).
    """
    try:
        components = generation.decode(raw).components
    except Exception:  # noqa: BLE001 — skip an unfinished partial (a defensive throw from decode, etc.) and wait for the next
        return None

    # Keep only completed components (per-component catalog validation; in-progress forms of unknown type or missing required props fall off here).
    complete: list[dict[str, Any]] = []
    for c in components:
        try:
            if len(ctx.catalog.validate([c], []).issues) == 0:
                complete.append(c)
        except Exception:  # noqa: BLE001,S112 — drop unexpected validator exceptions as unfinished
            continue
    if len(complete) == 0:
        return None

    # Prune children to already-arrived ids (an unarrived forward reference fails structural validation, so hide it in the provisional form).
    ids = {c.get("id") for c in complete}
    # Without a root component, model_validate/post_and_validate would raise purely to be caught by the
    # except below and turned back into None. Check for it directly instead — raising-and-immediately-
    # discarding an exception on every partial lacking root is pure waste on the streaming hot path (this
    # fires on every early partial before root has fully arrived).
    if "root" not in ids:
        return None
    pruned: list[dict[str, Any]] = []
    for c in complete:
        children = c.get("children")
        if isinstance(children, list):
            c = {**c, "children": [cid for cid in children if cid in ids]}
        pruned.append(c)
    # Do not emit a provisional while only root is complete (so as not to create a moment where the skeleton's
    # ui.loading is replaced by an empty container and "appears to vanish"; swap only after at least one real component is present).
    if not any(c.get("id") != "root" for c in pruned):
        return None

    raw_spec = {
        "kohaku": SPEC_VERSION,
        "intent": prepared.intent.to_wire(),
        "dataVersion": prepared.refs.dataVersion,
        **(
            {"refVersions": prepared.refs.versionsByRef}
            if len(prepared.refs.versionsByRef) > 0
            else {}
        ),
        "components": pruned,
        "events": [],
        "provenance": {"tier": "L1", "composedBy": COMPOSER_ID, "cache": "miss"},
    }
    try:
        # Run the same deterministic post-processing + validation + negotiate as the skeleton/final form (to
        # guarantee the Spec is always valid after applyPatch). Skip with None at stages that do not pass, such as root not yet arrived.
        spec = UISpec.model_validate(raw_spec)
        return negotiate_spec(post_and_validate(spec, prepared.refs, ctx), ctx)
    except Exception:  # noqa: BLE001 — skip an in-progress form that does not pass structural validation / post-processing
        return None


def _is_empty_patch(patch: SpecPatch) -> bool:
    """Whether the diff_spec result is "no diff" (only baseIntentHash)."""
    return (
        patch.intent is None
        and patch.upsert is None
        and patch.remove is None
        and patch.events is None
        and patch.dataVersion is None
        and not patch.is_field_set("refVersions")
        and not patch.is_field_set("state")
        and patch.provenance is None
    )


__all__ = [
    "ComposeError",
    "ComposeStreamEvent",
    "StreamDoneEvent",
    "StreamPatchEvent",
    "StreamSpecEvent",
    "compose_stream",
]
