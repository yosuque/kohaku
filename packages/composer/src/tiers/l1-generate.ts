import { buildGenerationSchema, type GenerationSchema } from "@kohaku-ui/registry";
import {
  type CanonicalIntent,
  type ComponentNode,
  type EventBinding,
  EventBindingSchema,
  SPEC_VERSION,
  type UISpec,
  validateSpecStructure,
} from "@kohaku-ui/spec-core";
import type { ComposeContext, ResolvedRefs } from "../context.js";
import { resolveTierLlm } from "../context.js";
import { errorMessage } from "../error-message.js";
import {
  appendL1RepairFeedback,
  buildL1PromptStatic,
  L1_SYSTEM_PROMPT,
  repairFeedbackSection,
} from "../prompt.js";
import { resolveMaxAttempts, runRepairLoop, type TierRequest, type TierResult } from "./shared.js";

/**
 * Relaxes every `data.$ref` field in a generation JSON Schema from `{ type: "string", enum: [...] }`
 * (buildGenerationSchema's default: an intent-specific enum of resolved QueryHandle URIs) down to a plain
 * `{ type: "string" }` — used only under `ComposePolicy.refConstraint === "validate"` (see
 * `buildL1GenerationSchema`). Recognizes the shape by structure (an object with both a `$ref` key whose
 * value carries an `enum` array) rather than a hardcoded path, so it survives unrelated shape changes to
 * buildGenerationSchema's variant construction. Returns a deep-cloned schema; the input (which
 * buildGenerationSchema may hand out from a cache) is never mutated.
 */
function relaxDataRefConstraint(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema);
  relax(clone);
  return clone;

  function relax(node: unknown): void {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) relax(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const refValue = obj["$ref"];
    if (
      refValue != null &&
      typeof refValue === "object" &&
      !Array.isArray(refValue) &&
      Array.isArray((refValue as Record<string, unknown>)["enum"])
    ) {
      obj["$ref"] = { type: "string" };
      // The enum values themselves carry nothing else worth recursing into (they are plain URI strings).
      return;
    }
    for (const value of Object.values(obj)) relax(value);
  }
}

/**
 * Builds the L1 generation schema (candidate narrowing via ComposePolicy.selectComponents) and
 * the `includeTypes` used alongside it in the prompt. Shared by generateL1 and compose-stream's provisional
 * decode path (both need exactly this schema/includeTypes pair, kept in lockstep to avoid a generation
 * vocabulary mismatch between the two — see the callers' comments).
 *
 * `ComposePolicy.refConstraint` (default `"schema"`) governs whether `data.$ref` is constrained here at
 * the schema/grammar stage (the enum this function would otherwise produce unconditionally) or left as a
 * plain string and instead checked explicitly after generation (`"validate"` — see `collectIssues`'s
 * `DATA_REF_UNRESOLVED` check below). Because kohaku's enum is a function of the resolved reference set,
 * which differs per intent, every intent recompiles a distinct output grammar under `"schema"`; `"validate"`
 * trades that per-intent grammar-compile cost for an explicit post-generation check, at the cost of no
 * longer having the LLM provider itself reject an out-of-set reference before it is even returned (see
 * docs/design.md §5 for the full trade-off and how to measure it before switching the default).
 */
export function buildL1GenerationSchema(
  ctx: ComposeContext,
  intent: CanonicalIntent,
  refs: ResolvedRefs,
): { generation: GenerationSchema; includeTypes: string[] | undefined } {
  const includeTypes = ctx.policy?.selectComponents?.(intent, ctx.catalog);
  const genOptions = includeTypes != null ? { includeTypes } : undefined;
  const generation = buildGenerationSchema(ctx.catalog, refs.uris, genOptions);
  const shouldRelax = ctx.policy?.refConstraint === "validate";
  return {
    generation: shouldRelax
      ? { ...generation, jsonSchema: relaxDataRefConstraint(generation.jsonSchema) }
      : generation,
    includeTypes,
  };
}

/**
 * L1 constrained generation.
 * Calls the LLM with a dynamically built generation schema, verifies with the true schema (catalog) +
 * structural validation, and on failure feeds back the list of errors and retries repair up to
 * maxRepairAttempts times (the loop skeleton itself lives in tiers/shared.ts's runRepairLoop, shared with L2).
 * signal passes through to the LLM call as req.abort, and an abort immediately falls to ok:false (failure="transient").
 */
export async function generateL1(req: TierRequest): Promise<TierResult> {
  const { intent, refs, ctx, signal, budget, onBudgetCheckError, onDraftPartial, startedAt, deadlineSignal } =
    req;
  // Candidate narrowing. selectComponents is deterministic with respect to the intent. Pass the
  // same includeTypes through both the schema and the prompt to prevent a mismatch in the generation vocabulary (the guardrail union is guaranteed downstream).
  // req.l1Schema (PreparedCompose.getL1Schema, threaded in by tier-ladder.ts) is memoized per compose —
  // reuse it when present so composeStream's provisional-patch decode loop and this call build the schema
  // at most once between them; fall back to building it directly when unset (a hand-built TierRequest in
  // tests, or the non-stream compose() path where nothing else needs this schema).
  const { generation, includeTypes } = req.l1Schema?.() ?? buildL1GenerationSchema(ctx, intent, refs);
  const maxAttempts = resolveMaxAttempts(ctx);
  // ComposeContext.llmByTier resolution (additive; resolves to ctx.llm when unset — see resolveTierLlm's doc).
  const llm = resolveTierLlm(ctx, "L1");
  const effort = ctx.policy?.effort?.l1;

  // few-shot examples are fetched just once before the loop, and the same examples are injected into every attempt including repair re-attempts.
  // A throw from examples() is swallowed and treated as empty (a supply-side failure does not stop generation).
  const fewShotPolicy = ctx.policy?.fewShot;
  const fewShot = fewShotPolicy
    ? (await fewShotPolicy.examples(intent).catch(() => [])).slice(0, fewShotPolicy.maxExamples ?? 2)
    : [];

  // The static portion of the L1 prompt (everything but the trailing repair-feedback section) depends
  // only on intent/catalog/refs/includeTypes/fewShot/outputLanguage — all fixed for the lifetime of this
  // call — so it is built exactly once here rather than rebuilt (full catalog + shape + few-shot fragment
  // construction) on every repair re-attempt; only the trailing feedback section varies per attempt
  // (appendL1RepairFeedback matches buildL1Prompt's own formatting exactly, so the resulting prompt bytes
  // are unchanged from before this was split out).
  const staticPrompt = buildL1PromptStatic({
    intent,
    catalog: ctx.catalog,
    refs: refs.uris,
    shapesByRef: refs.shapesByRef,
    ...(includeTypes != null ? { includeTypes } : {}),
    ...(ctx.policy?.outputLanguage != null ? { outputLanguage: ctx.policy.outputLanguage } : {}),
    ...(fewShot.length > 0 ? { fewShot } : {}),
  });

  return runRepairLoop(
    "l1",
    {
      maxAttempts,
      // Budget checked before every attempt including the first (a zero budget skips the LLM call entirely).
      budgetGate: "every",
      async call(feedback, attempt) {
        const request = {
          schema: { jsonSchema: generation.jsonSchema },
          schemaName: "ui_spec_draft",
          system: L1_SYSTEM_PROMPT,
          prompt: appendL1RepairFeedback(staticPrompt, feedback),
          // staticPrompt is already the byte-identical prefix shared by every attempt of this call (see
          // its own comment above); the only part that varies per attempt is the trailing repair-feedback
          // suffix, so that alone is `rest` (cacheable + rest === prompt holds by construction — the same
          // identity `buildL1PromptParts` documents). Built via `repairFeedbackSection` — the same helper
          // `buildL1PromptParts` uses internally — rather than by calling `buildL1PromptParts` itself, which
          // would rebuild the static prefix (catalog/shape/few-shot fragments) on every repair attempt; this
          // way the invariant has one home (repairFeedbackSection) without paying that rebuild cost. Purely
          // additive: a non-caching LlmPort (FakeLlm / FixtureLlm, or the default non-opted-in ai-sdk
          // adapter) ignores this field and reads `prompt`.
          promptParts: { cacheable: staticPrompt, rest: repairFeedbackSection(feedback) },
          temperature: 0,
          ...(signal != null ? { abort: signal } : {}),
          ...(effort != null ? { effort } : {}),
        };
        // Incremental streaming: streamObject only when it is the first attempt and both the notification target and the port implementation are present.
        // The final object is the same validated shape as generateObject, so the pipeline afterward does not branch.
        const useStream = attempt === 0 && onDraftPartial != null && llm.streamObject != null;
        const result = useStream
          ? await llm.streamObject!({ ...request, onPartial: onDraftPartial! })
          : await llm.generateObject(request);
        return { raw: result.object, model: result.model, usage: result.usage };
      },
      async validate(raw) {
        try {
          const draft = generation.decode(raw);
          const issues = collectIssues(draft.components, draft.events, intent, refs, ctx);
          if (issues.length === 0) {
            return { ok: true, components: draft.components, events: draft.events };
          }
          // A catalog/structural-validation failure is a repair target (L2-promotable "invalid").
          return { ok: false, issues };
        } catch (e) {
          // decode's defensive throw (rejects a non-array / a non-object element / a non-string on or emit) is
          // "a response exists but the shape is invalid", so treat it as a repairable "invalid". Do not make
          // it transient; put it on the repair loop as feedback (making it a hard exception would turn the
          // whole compose into INTERNAL / host 500). runRepairLoop always classifies a validate() failure as
          // "invalid" regardless of cause, matching this.
          const message = errorMessage(e);
          return { ok: false, issues: [message] };
        }
      },
    },
    budget,
    onBudgetCheckError,
    startedAt,
    deadlineSignal,
  );
}

function collectIssues(
  components: ComponentNode[],
  events: EventBinding[],
  intent: CanonicalIntent,
  refs: ResolvedRefs,
  ctx: ComposeContext,
): string[] {
  const issues: string[] = [];

  const catalogResult = ctx.catalog.validate(components, events);
  issues.push(...catalogResult.issues.map((i) => `${i.code} (${i.componentId}): ${i.message}`));

  // Validate events with spec-core's EventBinding schema. The generation schema's enum (emit) and
  // on form (componentId.eventName) are not enforced on the default prompt-JSON fallback path, so an
  // out-of-enum emit or a malformed 3-segment on slips past decode / catalog / structural validation and
  // turns into INTERNAL (host 500) at the final parseSpec Zod. Send it back here as a repair issue so it can be fixed by the repair loop (feedback).
  for (const [i, e] of events.entries()) {
    const parsed = EventBindingSchema.safeParse(e);
    if (!parsed.success) {
      issues.push(`EVENT_INVALID (events[${i}]): ${parsed.error.message}`);
    }
  }

  // Structural validation is done by wrapping a provisional envelope
  const provisional: UISpec = {
    kohaku: SPEC_VERSION,
    intent,
    dataVersion: refs.dataVersion,
    components: components.length > 0 ? components : [{ id: "root", type: "layout.stack", props: {} }],
    events,
    provenance: { tier: "L1", composedBy: "composer", cache: "miss" },
  };
  const structureIssues = validateSpecStructure(provisional).filter((i) => i.severity === "error");
  issues.push(...structureIssues.map((i) => `${i.code}: ${i.message}`));

  // Set-membership validation of data.$ref. Under the default ComposePolicy.refConstraint ("schema"),
  // this is defense in depth: the generation schema's $ref enum (registry generation) is not enforced on
  // the default KOHAKU_LLM_STRUCTURED_MODE=auto prompt-JSON fallback path, so the JSON.parse result
  // passes unvalidated (DataRefSchema too only checks URI grammar, not set membership) — the check below
  // catches that bypass. Under refConstraint "validate", the generation schema never constrained $ref to
  // an enum in the first place (buildL1GenerationSchema relaxes it to a plain string), so this check is
  // the *primary* enforcement mechanism, not merely a backstop — flagged with the distinct
  // DATA_REF_UNRESOLVED code so it reads as the expected outcome of that mode rather than the
  // schema-bypass case INVALID_REF names. Either way: re-confirm on the server side that each component's
  // data.$ref belongs to the URI set resolved by SemanticPort, and if it is outside, send it back as a
  // repair issue (a defense symmetric to L2 fixing primaryRef on the server side in l2-generate). If
  // delivered and cached with an out-of-set $ref, the host would issue a read capability to a reference
  // unrelated to the Intent.
  const allowedRefs = new Set(refs.uris);
  const refConstraint = ctx.policy?.refConstraint ?? "schema";
  const outOfSetRefCode = refConstraint === "validate" ? "DATA_REF_UNRESOLVED" : "INVALID_REF";
  for (const c of components) {
    const ref = c.data?.$ref;
    if (ref != null && !allowedRefs.has(ref)) {
      issues.push(`${outOfSetRefCode} (${c.id}): data.$ref "${ref}" is not in the resolved reference set`);
    }
  }

  if (components.length === 0) issues.push("components is empty");

  return issues;
}
