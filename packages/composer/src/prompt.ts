import type { LlmPort, PromptParts } from "@kohaku-ui/llm";
import { type ResolvedCatalog, selectGenerationTypes } from "@kohaku-ui/registry";
import { type CanonicalIntent, canonicalStringify, type DataShape } from "@kohaku-ui/spec-core";
import type { FewShotExample } from "./context.js";
import {
  type DesignSystemGuide,
  designKitPromptFragment,
  designSystemPromptFragment,
} from "./design-system.js";

/**
 * The L1/L2 prompt revision. Always bump it when changing the prompts (L1_SYSTEM_PROMPT /
 * L2_SYSTEM_PROMPT / buildL1Prompt / buildL2Prompt). It is the default material for generatorVersion,
 * and bumping it separates the cache by version. An operational value that PR review uses to enforce
 * against missed bumps.
 *
 * "2": the version that introduced few-shot self-reinforcement (3-9) into buildL1Prompt and turned it on
 * by default in sample-api. Because few-shot on/off and supply-source changes alter the prompt content,
 * this is raised per the operational rule of bumping generatorVersion (docs/design.md §few-shot). When
 * few-shot is not supplied, the output bytes are identical to the previous version.
 * "3": the version that spelled out the entire window.kohaku API surface (4 in total; onReady etc. do not
 * exist) and the call-form constraint in L2_SYSTEM_PROMPT, and added a repair-feedback section to
 * buildL2Prompt. The bump also causes old cached L2 outputs containing a hallucinated API (kohaku.onReady)
 * to be regenerated via generation separation.
 * "4": the version that added JS syntax rules (no raw newlines inside string literals; output as a complete
 * document) to L2_SYSTEM_PROMPT (paired with collectL2Issues' syntax check L2_SCRIPT_SYNTAX / truncation
 * check L2_TRUNCATED).
 * "5": the version that added chart-quality rules (mandatory ticks on both axes, axis labels, and units)
 * and real-data-only rules (no fabricating dimensions/values; no non-deterministic rendering such as
 * Math.random — paired with collectL2Issues' L2_NONDETERMINISM) to L2_SYSTEM_PROMPT.
 * "6": the version that changed the L2 output format from JSON ({title, html}) to a raw HTML document
 * (generateText path). Small models break systematically when embedding long HTML in JSON (grammar
 * constraint = truncation via early close / prompt JSON = broken escaping), so the format was aligned to
 * what a model writes naturally. title is derived from <title>.
 * "7": the version that added a no-library rule (D3/Chart.js etc. do not exist; raw DOM API only) to
 * L2_SYSTEM_PROMPT (paired with collectL2Issues' L2_LIB_UNAVAILABLE. Observed D3-style .attr() chains
 * creeping in during field use).
 * "8": the version that introduced a design-system section (designSystemPromptFragment — presenting the
 * token vocabulary var(--kohaku-*) and prohibiting raw color values) into buildL2Prompt (paired with the
 * lint L2_RAW_COLOR). In the same style as few-shot ("2"), the output bytes are identical to the previous
 * version when ComposePolicy.designSystem is unspecified. designSystem on/off and content changes are
 * separated by generation via a generatorVersion bump.
 * "9": the version that translated the repair-feedback strings (validation issues / L2 lint findings) to
 * English (part of making all runtime messages English).
 * "10": the version that translated the L1/L2 system prompts and dynamic sections to English and introduced
 * the output-language section (ComposePolicy.outputLanguage; default English). Generated user-visible text
 * now follows the specified output language regardless of the prompt's own language.
 * "11": the version that documents the sandbox's Worker-based execution model in L2_SYSTEM_PROMPT (generated
 * script now runs behind a DOM shim in a Web Worker rather than directly in the sandbox document — see
 * docs/design.md §8): one <style> in <head>, a single <script> just before </body> (concatenate multiple),
 * and which DOM shim APIs work normally versus which measurement APIs are only approximate or which globals
 * do not exist at all (paired with l2-generate's new L2_UNSAFE_MARKUP / L2_UNSUPPORTED_DOM lints).
 * "12": the version that extended the design-system token vocabulary beyond colors (font / space /
 * radius / shadow / motion — DEFAULT_TOKEN_DESCRIPTIONS), replaced L2_SYSTEM_PROMPT's "keep the design
 * simple" line with a design brief, and added the optional "Design kit" section (designKitPromptFragment,
 * paired with the L2_UNKNOWN_CLASS lint). When ComposePolicy.designSystem is unspecified the L2 prompt
 * still differs from "11" (the brief), so this bump separates every cached L2 generation.
 */
export const PROMPT_REVISION = "12";

/**
 * The default value of generatorVersion. Composes the prompt version + model ID.
 * A prompt revision (PROMPT_REVISION bump) or a model change separates the cacheKey,
 * so outputs can be generation-managed by version while avoiding a display flip-flop.
 *
 * **Design decision (per-tier LLMs, `ComposeContext.llmByTier`): this stays derived from the base `llm`
 * only — it does not grow an overload/variant that also takes the per-tier ports.** The composer never
 * calls this function itself (see the call-site note above `generatorVersion` on `ComposePolicy` — it is a
 * caller-facing convenience a host may or may not use to build its own `generatorVersion` string), so it
 * has no way to observe `ComposeContext.llmByTier` even if it wanted to, and a caller that *does* use this
 * helper is typically also passing a fixed `ComposeContext` object it does not reconstruct per call. The
 * cache separation per-tier models actually need is instead carried automatically by `policyFingerprint`'s
 * `tierLlm` argument (`context.ts`'s `tierLlmFingerprintMaterial`) — computed straight from
 * `ComposeContext.llmByTier` at the point `compose.ts` builds the cacheKey, with no dependence on whatever
 * string a caller happens to pass as `generatorVersion`. So: `generatorVersion` (via this helper or a
 * caller's own string) keeps answering "which prompt revision / which base model", and the fingerprint
 * answers "did this compose actually use a different model for some tier" — the two are complementary,
 * not duplicated.
 */
export function defaultGeneratorVersion(llm: Pick<LlmPort, "modelId">): string {
  return `p${PROMPT_REVISION}/${llm.modelId}`;
}

/**
 * The prompt for L1 constrained generation. Limits the LLM's job to "catalog selection + props filling",
 * and permits data only by reference ($ref), prohibiting direct writing of row data or numbers so that
 * bulk data never passes through the model's context (reference-passing principle).
 */
export const L1_SYSTEM_PROMPT = [
  "You are the constrained generator of a UI Composition Service.",
  "Your only job is selecting catalog components and filling their typed props. Strictly follow these rules:",
  '- Always include exactly one layout component (layout.stack or layout.grid) with id "root", and reference the other components via children',
  "- Data may only be a $ref (query reference) permitted by the schema. Never write row data, aggregates, or numbers directly into props",
  "- Use only column names that exist in the presented column metadata (columns)",
  "- Add exactly one heading (text.heading) whose title concisely expresses the user's intent, written in the output language specified below",
  "- Tables where drill-down is natural may have a rowClick event (emit: intent.patch)",
  "- Output only JSON that fully conforms to the schema",
].join("\n");

export function catalogPromptFragment(catalog: ResolvedCatalog, includeTypes?: readonly string[]): string {
  // Excluding generation:"excluded" and narrowing by includeTypes are consolidated in selectGenerationTypes.
  // This makes the prompt's enumeration and buildGenerationSchema's variants share the same vocabulary
  // (do not present to the LLM a "component the schema cannot emit" / conversely, do not let it emit an "un-presented component").
  const included = new Set(selectGenerationTypes(catalog, includeTypes));
  return catalog
    .list()
    .filter((def) => included.has(def.type))
    .map((def) => {
      const caps = [
        `data:${def.capabilities.data}`,
        `children:${def.capabilities.children}`,
        def.capabilities.events.length > 0 ? `events:${def.capabilities.events.join("/")}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `- ${def.type}@${def.version} (${caps}): ${def.description}`;
    })
    .join("\n");
}

export function shapePromptFragment(shapesByRef: Map<string, DataShape>): string {
  if (shapesByRef.size === 0) return "(no column metadata)";
  return [...shapesByRef.entries()]
    .map(([ref, shape]) => {
      const cols = shape.columns
        .map((c) => `${c.name}:${c.type}${c.role != null ? `(${c.role})` : ""}`)
        .join(", ");
      const rows = shape.rowCountHint != null ? ` approx. rows=${shape.rowCountHint}` : "";
      return `- ${ref}\n  columns: ${cols}${rows}`;
    })
    .join("\n");
}

export interface BuildL1PromptStaticArgs {
  intent: CanonicalIntent;
  catalog: ResolvedCatalog;
  refs: string[];
  shapesByRef: Map<string, DataShape>;
  /** Candidate narrowing. Always pass the same value as buildGenerationSchema's includeTypes (vocabulary match). */
  includeTypes?: readonly string[];
  /**
   * Good examples for few-shot. Inserts a "examples of good composition" section after the catalog and before the instructions.
   * **When unspecified/empty array, the output is byte-for-byte identical to the previous version** (the section itself is not added).
   */
  fewShot?: FewShotExample[];
  /**
   * The language of generated user-visible text (ComposePolicy.outputLanguage). Default "English".
   * Changing it changes the prompt content — always bump generatorVersion (same rule as few-shot).
   */
  outputLanguage?: string;
}

/**
 * Builds every L1-prompt section except the trailing repair-feedback one (canonical intent through
 * instructions). Depends only on intent/catalog/refs/shapesByRef/includeTypes/fewShot/outputLanguage —
 * all fixed for the lifetime of one generateL1 call — so callers that repair-loop across several attempts
 * (tiers/l1-generate.ts) can build this exactly once and reuse it for every attempt, appending only the
 * per-attempt repair feedback via `appendL1RepairFeedback` instead of paying the full catalog/shape/
 * few-shot fragment construction cost again on each repair re-attempt.
 */
export function buildL1PromptStatic(args: BuildL1PromptStaticArgs): string {
  const sections = [
    `## Canonical intent\n${canonicalStringify({ canonical: args.intent.canonical, params: args.intent.params })}`,
    `## Available data references (only these URIs may be used as data.$ref)\n${args.refs.map((r) => `- ${r}`).join("\n") || "(none)"}`,
    `## Data shape (column metadata)\n${shapePromptFragment(args.shapesByRef)}`,
    `## Component catalog\n${catalogPromptFragment(args.catalog, args.includeTypes)}`,
  ];
  // few-shot goes "after the catalog and before the instructions". When empty/unspecified, do not add the section (output bytes unchanged).
  if (args.fewShot != null && args.fewShot.length > 0) {
    sections.push(fewShotPromptFragment(args.fewShot));
  }
  sections.push(
    `## Output language\nWrite all user-visible text (the heading title, labels, annotations) in ${args.outputLanguage ?? "English"}.`,
  );
  sections.push("## Instructions\nCompose the UI that best expresses this intent as components / events.");
  return sections.join("\n\n");
}

/**
 * The "problems in the previous generation" section text (including its own leading `\n\n`), shared by
 * `appendL1RepairFeedback` and `appendL2RepairFeedback` (both tiers format repair feedback identically).
 * Returns "" when `repairFeedback` is unset/empty, so `base + repairFeedbackSection(fb)` is always exactly
 * equivalent to the old per-tier "append if non-empty, else return base unchanged" logic.
 *
 * Exported so a caller that already holds the static prefix (`generateL1` in tiers/l1-generate.ts, which
 * builds it once and reuses it across repair attempts) can construct `PromptParts` directly as
 * `{ cacheable: staticPrompt, rest: repairFeedbackSection(feedback) }` instead of re-deriving `rest` through
 * an `appendL1RepairFeedback("", feedback)` empty-string trick or re-running `buildL1PromptParts` (which
 * would rebuild the static prefix on every attempt). This keeps the `cacheable + rest === prompt` invariant
 * anchored to this one function rather than duplicated by convention in two places.
 */
export function repairFeedbackSection(repairFeedback?: string[]): string {
  if (repairFeedback == null || repairFeedback.length === 0) return "";
  return `\n\n## Problems in the previous generation (must be fixed)\n${repairFeedback.map((f) => `- ${f}`).join("\n")}`;
}

/**
 * Appends the "problems in the previous generation" repair-feedback section to an L1 static prompt (from
 * `buildL1PromptStatic`), matching `buildL1Prompt`'s own trailing-section formatting exactly. When
 * `repairFeedback` is unset/empty, returns `base` unchanged (byte-identical to the no-repair-feedback case).
 */
export function appendL1RepairFeedback(base: string, repairFeedback?: string[]): string {
  return base + repairFeedbackSection(repairFeedback);
}

export function buildL1Prompt(args: BuildL1PromptStaticArgs & { repairFeedback?: string[] }): string {
  return appendL1RepairFeedback(buildL1PromptStatic(args), args.repairFeedback);
}

/**
 * Same content as `buildL1Prompt`, split at the boundary a prompt-caching-capable LlmPort adapter (see
 * @kohaku-ui/llm's `PromptParts`) can exploit: `cacheable` is `buildL1PromptStatic(args)` — everything
 * that stays byte-identical across the repair loop's re-attempts for one L1 call (canonical intent /
 * refs / data shape / catalog / few-shot / output language, all fixed for the call's lifetime per
 * `buildL1PromptStatic`'s own doc) — and `rest` is only the trailing repair-feedback section, which is
 * the one part that actually changes attempt-to-attempt. **Invariant (always holds by construction):
 * `cacheable + rest === buildL1Prompt(args)`.** Reordering the sections to front-load catalog/few-shot
 * ahead of the (necessarily per-intent) canonical intent would let a wider cross-intent cache boundary
 * exist, but was rejected here because it would change `buildL1Prompt`'s existing byte output — this
 * split instead targets the boundary that is provably safe to introduce without touching a single byte
 * of the conventional (non-caching) prompt.
 */
export function buildL1PromptParts(
  args: BuildL1PromptStaticArgs & { repairFeedback?: string[] },
): PromptParts {
  return { cacheable: buildL1PromptStatic(args), rest: repairFeedbackSection(args.repairFeedback) };
}

/**
 * The prompt fragment for few-shot examples (3-9). For each example, deterministically lays out the
 * normalized Intent and the skeleton of components / events via canonicalStringify. The heading makes
 * explicit that data must be a $ref reference.
 */
export function fewShotPromptFragment(examples: readonly FewShotExample[]): string {
  const body = examples
    .map(
      (ex) =>
        `${canonicalStringify({ canonical: ex.intent.canonical, params: ex.intent.params })}\n${canonicalStringify(
          { components: ex.spec.components, events: ex.spec.events },
        )}`,
    )
    .join("\n\n");
  return `## Examples of good composition (follow this form; data must be $ref references)\n${body}`;
}

/**
 * The prompt for L2 free generation. A contract to use only the window.kohaku bridge API (paired with
 * the sandbox's runtime.ts). The API surface is explicitly closed as "4 in total" — because if a small
 * model generates a hallucinated API such as onReady, it results in a slow, unfriendly failure: runtime
 * TypeError → ready() not sent → boot timeout.
 * The call-form constraint (direct call of window.kohaku.methodName) is paired with l2-generate's static lint.
 */
export const L2_SYSTEM_PROMPT = [
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
  "- Write complete JavaScript with no syntax errors. In particular, never put a raw newline inside a string literal (' or \") — use a template literal (`) when a multi-line string is needed",
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
].join("\n");

export interface BuildL2PromptStaticArgs {
  intent: CanonicalIntent;
  refs: string[];
  shapesByRef: Map<string, DataShape>;
  /**
   * The design system (ComposePolicy.designSystem). When specified, inserts a design-system section
   * after the data shape and before the instructions. **When unspecified, the output is byte-for-byte identical to the previous version** (same style as few-shot).
   */
  designSystem?: DesignSystemGuide;
  /** The language of generated user-visible text (ComposePolicy.outputLanguage). Default "English". */
  outputLanguage?: string;
}

/**
 * Builds every L2-prompt section except the trailing repair-feedback one (canonical intent through
 * instructions) — the L2 analogue of `buildL1PromptStatic`. Depends only on intent/refs/shapesByRef/
 * designSystem/outputLanguage, all fixed for the lifetime of one generateL2 call, so it is the natural
 * "cacheable" half of `buildL2PromptParts`.
 */
export function buildL2PromptStatic(args: BuildL2PromptStaticArgs): string {
  const sections = [
    `## User request (canonical intent)\n${canonicalStringify({ canonical: args.intent.canonical, params: args.intent.params })}`,
    `## Available data references\n${args.refs.map((r) => `- ${r}`).join("\n") || "(none)"}`,
    `## Data shape\n${shapePromptFragment(args.shapesByRef)}`,
  ];
  if (args.designSystem != null) {
    sections.push(designSystemPromptFragment(args.designSystem));
    if (args.designSystem.kit != null) sections.push(designKitPromptFragment(args.designSystem.kit));
  }
  sections.push(
    `## Output language\nWrite all user-visible text (the <title>, labels, annotations) in ${args.outputLanguage ?? "English"}.`,
  );
  sections.push(
    "## Instructions\nOutput a self-contained HTML widget (a complete HTML document) that fulfills this request.",
  );
  return sections.join("\n\n");
}

/**
 * Appends the "problems in the previous generation" repair-feedback section to an L2 static prompt (from
 * `buildL2PromptStatic`), matching `buildL2Prompt`'s own trailing-section formatting exactly (the L2
 * analogue of `appendL1RepairFeedback`).
 */
export function appendL2RepairFeedback(base: string, repairFeedback?: string[]): string {
  return base + repairFeedbackSection(repairFeedback);
}

export function buildL2Prompt(
  args: BuildL2PromptStaticArgs & {
    /** Findings from the static lint (collectL2Issues). Like L1, sent back into the repair re-attempt prompt. */
    repairFeedback?: string[];
  },
): string {
  return appendL2RepairFeedback(buildL2PromptStatic(args), args.repairFeedback);
}

/**
 * Same content as `buildL2Prompt`, split at the L2 analogue of `buildL1PromptParts`'s boundary:
 * `cacheable` is `buildL2PromptStatic(args)` (everything fixed across one L2 call's repair re-attempts)
 * and `rest` is only the trailing repair-feedback section. **Invariant (always holds by construction):
 * `cacheable + rest === buildL2Prompt(args)`.** See `buildL1PromptParts`'s doc for why this boundary
 * (rather than a wider, cross-intent one) was chosen.
 */
export function buildL2PromptParts(
  args: BuildL2PromptStaticArgs & { repairFeedback?: string[] },
): PromptParts {
  return { cacheable: buildL2PromptStatic(args), rest: repairFeedbackSection(args.repairFeedback) };
}
