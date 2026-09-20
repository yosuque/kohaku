import { type ComponentNode, SANDBOX_HTML_TYPE, sha256Hex } from "@kohaku-ui/spec-core";
import { resolveTierLlm } from "../context.js";
import { errorMessage } from "../error-message.js";
import { KOHAKU_API_ALLOWLIST } from "../l2-api.js";
import { buildL2PromptParts, L2_SYSTEM_PROMPT } from "../prompt.js";
import { resolveMaxAttempts, runRepairLoop, type TierRequest, type TierResult } from "./shared.js";

// The allowed window.kohaku bridge APIs (paired with the surface the sandbox's runtime.ts exposes; if they diverge, the lint breaks).
// The definition source is the node-independent standalone module ../l2-api.ts (separated so downstream sandbox can import it while preserving the dependency direction).

/**
 * The L2 output budget factor. Because L2 generates full HTML (including axis/tick charts, measured at
 * 6-12KB), the L1-baseline (small JSON) KOHAKU_LLM_TIMEOUT_MS / KOHAKU_LLM_MAX_OUTPUT_TOKENS run out on
 * the time/token upper-bound side first (measured: local ollama gemma4:e4b L2 generation sits on the
 * boundary of the default 60s and falls to ABORTED → fallback due to fluctuations such as cold starts).
 * Expand both time and output tokens by 3x.
 */
const L2_OUTPUT_BUDGET_FACTOR = 3;

/**
 * Whether dynamic code generation (new Function) is usable. In environments that forbid CSP unsafe-eval
 * or isolate environments (Cloudflare Workers etc.), skip the syntax check entirely (fail-open — do not
 * break the whole compose in an environment where checking is impossible). The probe is evaluated only
 * once and cached.
 */
let scriptSyntaxCheckAvailable: boolean | null = null;
function canCheckScriptSyntax(): boolean {
  if (scriptSyntaxCheckAvailable == null) {
    try {
      new Function("");
      scriptSyntaxCheckAvailable = true;
    } catch {
      scriptSyntaxCheckAvailable = false;
    }
  }
  return scriptSyntaxCheckAvailable;
}

/**
 * Static lint of L2-generated HTML (bridge-contract check). Detects, before delivery, references to
 * methods that the sandbox's window.kohaku does not expose (LLM-hallucinated APIs — e.g. onReady) and a
 * missing ready() call. Both result at runtime in the slow, unfriendly failure of "ui.ready never
 * arrives, nothing displayed until boot timeout (default 5 seconds)", so send them back at generation
 * time as repair issues. Being a lexical check, it may react to strings inside comments too, but a false
 * positive merely wastes one repair re-attempt and does not err on the side of dropping a correct output.
 *
 * opts.enforceTokenColors is the raw-color check (L2_RAW_COLOR) for when a design system is applied.
 * Default false (the conventional behavior with designSystem unset is completely unchanged). generateL2 wires it from ComposePolicy.designSystem.
 */
export function collectL2Issues(html: string, opts?: { enforceTokenColors?: boolean }): string[] {
  const issues: string[] = [];
  const used = new Set<string>();
  // Extract the window.kohaku.xxx / kohaku?.xxx form (on the premise that, since L2_SYSTEM_PROMPT enforces
  // the direct-call form, destructuring or aliasing is not generated. A deviation is detected as a missing ready).
  for (const m of html.matchAll(/kohaku\s*\??\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    used.add(m[1]!);
  }
  for (const name of [...used].sort()) {
    if (!KOHAKU_API_ALLOWLIST.has(name)) {
      issues.push(
        `L2_UNKNOWN_API: window.kohaku.${name} does not exist (it will throw a TypeError at runtime). ` +
          "The only available APIs are fetchData / emit / onProps / ready. " +
          `Remove every occurrence of kohaku.${name}, including comments`,
      );
    }
  }
  if (!used.has("ready")) {
    issues.push(
      "L2_READY_MISSING: window.kohaku.ready() is never called. Always call window.kohaku.ready() directly " +
        "when rendering completes (including when data fetching fails); destructuring or aliasing is not allowed",
    );
  }
  // Syntax check (sending back JS syntax errors). Delegated to the carved-out collectScriptSyntaxIssues
  // (since Python has no JS execution engine, it reuses just this checker from a CLI sidecar).
  issues.push(...collectScriptSyntaxIssues(html));
  // Truncation detection: a complete single HTML document ends with </html> (the L2_SYSTEM_PROMPT contract).
  // An output truncated by the output-token limit etc. is a breeding ground for syntax errors or rendering cutoff, so send it back.
  if (!/<\/html>\s*$/i.test(html)) {
    issues.push(
      "L2_TRUNCATED: the HTML document does not end with </html> (output may be truncated). " +
        "Output a complete single HTML document",
    );
  }
  // Non-deterministic rendering detection: Math.random breaks both "fabricating values not in the data"
  // (observed in the field: random-generating the tooltip's sales amount) and the cache-premise
  // determinism of "same data → same display", so send it back. Being a lexical check it also reacts
  // inside comments, but erring on the side of it being removed by repair is acceptable.
  if (/Math\s*\.\s*random\s*\(/.test(html)) {
    issues.push(
      "L2_NONDETERMINISM: Math.random() is used. The widget must render deterministically " +
        "from the actual data returned by fetchData (generating fake values from random numbers or dummy data is forbidden)",
    );
  }
  // Navigation detection: the generated script now runs inside a Worker with no document/assignable
  // location/window.open of its own (SBX-EXEC-001), so this class of attempt is neutralized by the runtime
  // regardless — but sending it back before delivery still saves a repair round-trip versus letting the model
  // discover the TypeError only at smoke-validation or runtime.
  if (L2_NAVIGATION_RE.test(html)) {
    issues.push(
      "L2_NAVIGATION: the document navigates (meta refresh / location assignment / window.open). " +
        "Navigation APIs do not exist in the sandbox runtime; render in place and use window.kohaku.emit for interactions",
    );
  }
  // Markup the applier's allowlist always rejects (packages/spec-core/src/schema/sandbox-dom.ts): sent back
  // before delivery for the same reason as L2_NAVIGATION above — none of this ever reaches the real DOM once
  // the applier drops it, so catching it here saves a repair round-trip.
  if (L2_UNSAFE_MARKUP_RE.test(html)) {
    issues.push(
      "L2_UNSAFE_MARKUP: the document contains markup the sandbox's DOM applier always rejects " +
        "(an <iframe>/<object>/<embed>/<form>/<base>/<link>/<frame>/<applet> element, an on*= event-handler " +
        "attribute, a javascript: URL, or a <script src=...>). None of these ever reach the real DOM " +
        "(the applier drops them and the widget renders without them); use the DOM shim API's " +
        "addEventListener and window.kohaku.emit instead",
    );
  }
  // APIs the Worker DOM shim does not provide at all (see guest/worker-shim.ts's module docstring): calling
  // one throws a TypeError, so — like L2_UNKNOWN_API for the window.kohaku surface — send it back before
  // delivery rather than let it surface only as a runtime failure.
  if (L2_UNSUPPORTED_DOM_RE.test(html)) {
    issues.push(
      "L2_UNSUPPORTED_DOM: the code uses an API that does not exist in the sandbox's Worker DOM shim " +
        "(canvas getContext, document.write, alert/confirm/prompt, localStorage/sessionStorage/indexedDB, " +
        "document.cookie, or MutationObserver/IntersectionObserver). Calling any of these throws a TypeError " +
        "at runtime; render only through the DOM shim API and window.kohaku",
    );
  }
  // External-library trace detection: because the sandbox cannot load external scripts under CSP, all
  // chart-library APIs become a runtime TypeError. What was observed in the field is D3-style method
  // chains (plain DOM's append() returns undefined, so .attr() gives "Cannot read properties of
  // undefined"). Since `.attr("...")` is a library-specific form that does not exist on plain DOM, send it
  // back via a lexical check together with direct references to library names.
  for (const [pattern, label] of L2_LIB_SIGNATURES) {
    if (pattern.test(html)) {
      issues.push(
        `L2_LIB_UNAVAILABLE: the code uses ${label}. The sandbox cannot load external libraries, ` +
          "and plain DOM elements have no .attr() or similar methods (it will throw a TypeError at runtime). " +
          "Build SVG with document.createElementNS + setAttribute, or assemble a string and insert it via innerHTML",
      );
    }
  }
  // Raw-color detection (only when a design system is applied). Baking in concrete colors cannot follow a
  // theme switch and breaks the Spec's theme independence (SPEC-ENV-003) and the cache's cross-theme
  // reuse, so send back a substitution to token references var(--kohaku-*). To avoid reacting to CSS id
  // selectors (#chart etc.), #hex is judged by 3-8 hex digits + a word boundary (an id with the same form
  // as a hex value such as #fee is a false positive, but err toward repair).
  if (opts?.enforceTokenColors === true && L2_RAW_COLOR_RE.test(html)) {
    issues.push(
      "L2_RAW_COLOR: hard-coded colors (#hex / rgb() / hsl() etc.) are present. Always specify colors " +
        "with design tokens var(--kohaku-*) (e.g. color: var(--kohaku-color-text), background " +
        "var(--kohaku-color-background), chart series var(--kohaku-chart-palette-1) …)",
    );
  }
  return issues;
}

/** Raw-color detection pattern (hex literal / rgb() / rgba() / hsl() / hsla()). */
const L2_RAW_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;

/**
 * Navigation detection pattern (meta refresh / location assignment / window.open). Tolerant of spacing and
 * quote style. `location.href =` deliberately matches only assignment (not e.g. reading `location.href` for
 * display), since reading is harmless and flagging it would be a false positive with no repair path.
 */
const L2_NAVIGATION_RE =
  /<meta\s+http-equiv\s*=\s*["']?\s*refresh|location\s*\.\s*href\s*=|location\s*\.\s*assign\s*\(|location\s*\.\s*replace\s*\(|window\s*\.\s*open\s*\(/i;

/**
 * Markup the applier's allowlist (packages/spec-core/src/schema/sandbox-dom.ts) always rejects: a denied
 * element, an `on*=` event-handler attribute or property assignment, a `javascript:` URL, or a
 * `<script src=...>`. Tolerant of spacing and quote style, like L2_NAVIGATION_RE.
 *
 * The `on*=` alternatives are deliberately scoped to an HTML-attribute context (`<tag ... onclick=...>`) or a
 * property-assignment context (`el.onclick = ...`) rather than a bare `on[a-z]+\s*=` anywhere in the text —
 * the latter would false-positive on an ordinary, idiomatic variable name such as `const onRowClick = ...`
 * (common in generated event-handler code), which is neither markup nor a property assignment and works fine.
 * `window.kohaku.onProps(cb)` (a method *call*, never followed by `=`) is unaffected either way.
 */
const L2_UNSAFE_MARKUP_RE =
  /<(?:iframe|object|embed|form|base|link|frame|applet)\b|<[a-zA-Z][^>]*\son[a-z]+\s*=|\.\s*on[a-z]+\s*=(?!=)|javascript\s*:|<script\b[^>]*\bsrc\s*=/i;

/** APIs the Worker DOM shim (guest/worker-shim.ts) never provides — see its module docstring's "always unavailable" list. */
const L2_UNSUPPORTED_DOM_RE =
  /\.\s*getContext\s*\(|document\s*\.\s*write\s*\(|\b(?:alert|confirm|prompt)\s*\(|\b(?:localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie\b|\b(?:MutationObserver|IntersectionObserver)\b/;

/**
 * Detects syntax errors by only compiling (not executing) each <script> of L2-generated HTML with
 * new Function. Sends back, before delivery, breakage that a lexical lint cannot catch such as raw
 * newlines or invalid tokens inside string literals (runtime SyntaxError → ready() not sent) (a failure
 * observed in the field). new Function's function body, like a classic <script>, rejects top-level
 * await / import / export, so it is a valid approximation.
 *
 * In environments where new Function is unusable (CSP unsafe-eval forbidden, isolate, etc.), skip the
 * check entirely and return [] (fail-open — do not break compose in an environment where checking is
 * impossible). Besides being called by collectL2Issues, the Python implementation, which has no JS
 * execution engine, reuses just this checker from a CLI sidecar (kohaku smoke-l2 --lint).
 */
export function collectScriptSyntaxIssues(html: string): string[] {
  if (!canCheckScriptSyntax()) return [];
  const issues: string[] = [];
  let scriptIndex = 0;
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    scriptIndex += 1;
    const body = m[1]!;
    if (body.trim() === "") continue;
    try {
      new Function(body);
    } catch (e) {
      const message = errorMessage(e);
      issues.push(
        `L2_SCRIPT_SYNTAX: <script> #${scriptIndex} has a JavaScript syntax error (${message}). ` +
          "Output syntactically valid, complete code — e.g. never put raw newlines " +
          "inside string literals (use template literals for multi-line strings)",
      );
    }
  }
  return issues;
}

/** Traces of libraries unusable in the sandbox (detection patterns and labels for repair feedback). */
const L2_LIB_SIGNATURES: readonly [RegExp, string][] = [
  [/\bd3\s*\./, "D3 (d3.*)"],
  [/new\s+Chart\s*\(/, "Chart.js (new Chart)"],
  [/\becharts\s*\./, "ECharts (echarts.*)"],
  [/\bHighcharts\s*\./, "Highcharts"],
  // A D3 / jQuery-style .attr("...") method chain (does not exist on plain DOM)
  [/\.attr\s*\(\s*["'`]/, "a D3/jQuery-style .attr() chain"],
];

/**
 * Extracts the HTML document body from the generated text. L2 has raw HTML generated rather than
 * JSON-wrapped (small models break systematically in the "embed huge HTML in a JSON string" form — the
 * grammar-constraint mode closes the string partway and cuts it off, and the prompt-JSON mode breaks the
 * JSON via broken escaping. Measured). Even if the model wraps it in a code fence or a preamble/postscript,
 * adopt from the first <!DOCTYPE html> (or <html> if absent) to the last </html>. Judging a missing close
 * (truncation) is handled by collectL2Issues' L2_TRUNCATED.
 */
export function extractHtmlDocument(text: string): string {
  const fenced = /```(?:html)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/<!DOCTYPE\s+html/i);
  const htmlAt = start >= 0 ? start : body.search(/<html[\s>]/i);
  const candidate = htmlAt >= 0 ? body.slice(htmlAt) : body;
  // Trim a trailing postscript (explanatory text etc.) up to the last </html> (greedy match = the last closing tag).
  const closed = /^[\s\S]*<\/html>/i.exec(candidate);
  return (closed?.[0] ?? candidate).trim();
}

/** Extracts the display title from the generated HTML's <title> (fallback if absent). */
export function extractTitle(html: string, fallback: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = m?.[1]?.replace(/\s+/g, " ").trim();
  return title != null && title !== "" ? title.slice(0, 120) : fallback;
}

/**
 * L2 free generation (the sandbox-limited escape hatch used when the constrained catalog cannot express
 * the request). The generated HTML is contracted to fetch data only via the window.kohaku bridge API and
 * rides on the Spec as an artifact (inline + sha256). Execution is isolated by the sandbox package.
 * The output is checked by the bridge-contract lint (collectL2Issues), and on failure the issues are fed
 * back and repair is retried up to maxRepairAttempts times, like L1 (sending back hallucinated APIs before delivery).
 */
export async function generateL2(req: TierRequest): Promise<TierResult> {
  const { intent, refs, ctx, signal, budget, onBudgetCheckError, startedAt, deadlineSignal } = req;
  // The sandbox bridge allows only a ref that exactly matches the sandbox node's data.$ref (the sandbox1
  // node below declares only primaryRef=refs.uris[0]). Present only primaryRef as "available" in the
  // prompt too, to match the allowlist and the contract. Presenting a second or later ref would make
  // the generated HTML's fetchData(2nd ref) break at runtime with ERR_REF_NOT_ALLOWED.
  const primaryRef = refs.uris[0];
  const promptRefs = primaryRef != null ? [primaryRef] : [];
  const shapesForPrompt = new Map([...refs.shapesByRef].filter(([uri]) => uri === primaryRef));
  const maxAttempts = resolveMaxAttempts(ctx);
  // Design-system application (ComposePolicy.designSystem). Wires as a pair the insertion of the prompt
  // section and the enabling of the raw-color lint (L2_RAW_COLOR) (enforceTokenColors default true).
  const designSystem = ctx.policy?.designSystem;
  const enforceTokenColors = designSystem != null && designSystem.enforceTokenColors !== false;
  // ComposeContext.llmByTier resolution (additive; resolves to ctx.llm when unset — see resolveTierLlm's doc).
  const llm = resolveTierLlm(ctx, "L2");
  const effort = ctx.policy?.effort?.l2;

  return runRepairLoop(
    "l2",
    {
      maxAttempts,
      // Budget check: the first attempt (attempt 0) is not double-checked because compose's "before L2"
      // check already did it immediately before (spent is unchanged too) — even though check() is idempotent,
      // avoid double-firing onBudgetCheckError. A repair re-attempt (attempt 1+) is an additional LLM call
      // that this loop adds, so check it immediately before, like L1.
      budgetGate: "afterFirst",
      async call(feedback) {
        // L2 generates a raw HTML document with generateText (no JSON wrap). Because small models break
        // systematically in the "embed long HTML in a JSON string field" form (see extractHtmlDocument's
        // docstring), use the format the model writes most naturally.
        // buildL2PromptParts's {cacheable, rest} concatenation is byte-identical to buildL2Prompt's output
        // (see its doc) — cacheable is everything fixed across this call's repair re-attempts (intent /
        // refs / shape / designSystem / outputLanguage), rest is only the trailing repair-feedback section
        // that actually differs attempt-to-attempt. Purely additive: a non-caching LlmPort ignores it.
        const { cacheable, rest } = buildL2PromptParts({
          intent,
          refs: promptRefs,
          shapesByRef: shapesForPrompt,
          ...(designSystem != null ? { designSystem } : {}),
          ...(ctx.policy?.outputLanguage != null ? { outputLanguage: ctx.policy.outputLanguage } : {}),
          ...(feedback.length > 0 ? { repairFeedback: feedback } : {}),
        });
        const result = await llm.generateText({
          system: L2_SYSTEM_PROMPT,
          prompt: cacheable + rest,
          promptParts: { cacheable, rest },
          temperature: 0,
          outputBudgetFactor: L2_OUTPUT_BUDGET_FACTOR,
          ...(signal != null ? { abort: signal } : {}),
          ...(effort != null ? { effort } : {}),
        });
        // model is the tier's actually-used port's modelId (llm, resolved via resolveTierLlm) rather than
        // the base ctx.llm — generateText's own result carries no model field (unlike GenerateObjectResult),
        // so this is the only place the actual model identity is available to record into the attempt/trace.
        return { raw: extractHtmlDocument(result.text), model: llm.modelId, usage: result.usage };
      },
      async validate(raw) {
        const html = raw as string;
        let issues = collectL2Issues(html, { enforceTokenColors });
        // Once the static lint passes, pre-delivery smoke validation (an optional hook). Detects, via jsdom
        // execution, failures that a lexical lint slips past — such as ready() not being reached due to a
        // runtime TypeError — and sends them back for repair. A throw is fail-open (skip the check =
        // conventional behavior; like the budget hook, a validator fault does not stop L2 delivery).
        if (issues.length === 0 && ctx.policy?.l2Smoke != null) {
          const shape = primaryRef != null ? refs.shapesByRef.get(primaryRef) : undefined;
          try {
            issues = await ctx.policy.l2Smoke(html, {
              ...(primaryRef != null ? { ref: primaryRef } : {}),
              ...(shape != null ? { shape } : {}),
            });
          } catch {
            issues = [];
          }
        }
        if (issues.length === 0) {
          const fallbackTitle =
            typeof intent.params["request"] === "string" && intent.params["request"] !== ""
              ? (intent.params["request"] as string)
              : "Custom view";
          const title = extractTitle(html, fallbackTitle);
          const sha256 = await sha256Hex(html);
          const components: ComponentNode[] = [
            {
              id: "root",
              type: "layout.stack",
              props: { direction: "vertical", gap: "md" },
              children: ["title1", "sandbox1"],
            },
            {
              id: "title1",
              type: "text.heading",
              props: { level: 2, text: title },
            },
            {
              id: "sandbox1",
              type: SANDBOX_HTML_TYPE,
              props: { title },
              artifact: { inline: html, sha256 },
              ...(primaryRef != null ? { data: { $ref: primaryRef } } : {}),
            },
          ];
          return { ok: true, components, events: [] };
        }
        // A bridge-contract lint failure is a repair target. Send the issues back into the next attempt's prompt as feedback.
        return { ok: false, issues };
      },
    },
    budget,
    onBudgetCheckError,
    startedAt,
    deadlineSignal,
  );
}
