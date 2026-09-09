import {
  type ComposeContext,
  type ComposeObserver,
  type ComposePolicy,
  composeObservers,
  defaultGeneratorVersion,
} from "@kohaku-ui/composer";
import type { LlmPort } from "@kohaku-ui/llm";
import { createOtelComposeObserver } from "@kohaku-ui/otel";
import { createL2Smoke } from "@kohaku-ui/sandbox/smoke";
import type { FixationRecord, SemanticPort, SessionContext, StoragePort } from "@kohaku-ui/spec-core";
import { SALES_DESIGN_SYSTEM } from "../design-system.js";
import { createFixationFewShot } from "../fewshot.js";
import { createFixedSpecs, type OutputLang } from "../intents/fixed-specs.js";
import type { PromotedRegistry } from "../intents/promoted-registry.js";

export type { OutputLang };

/**
 * Maps a session locale tag to the output language ("ja" prefix match — "ja", "ja-JP", … → "ja";
 * everything else, including absence, stays the English default).
 */
export function languageOf(locale?: string): OutputLang {
  return locale === "ja" || locale?.startsWith("ja-") === true ? "ja" : "en";
}

/**
 * The fixation delivery-admission gate shared by both host profiles (REST's `KohakuHostDeps.fixationAdmit` /
 * MCP's `McpHostDeps.fixationAdmit`, both wired from `createApp`'s callers): FixationRecord carries no
 * language and every pinned Spec was fixated from EN traffic, so the shortcut serves EN sessions only; JA
 * sessions fall through to normal compose (JA cache hit or JA generation via the compose-context policy
 * pair). Centralized here (rather than duplicated inside each profile's own fixation-lookup wiring) so REST
 * and MCP apply the exact same policy.
 */
export function admitFixationForLocale(_fixation: FixationRecord, session: SessionContext): boolean {
  return languageOf(session.locale) === "en";
}

/**
 * Assembles the ComposeContext.
 * `catalog` is kept as a getter and always returns the latest base catalog even after reconcile.
 */
export function createComposeContext(args: {
  registry: PromotedRegistry;
  semantic: SemanticPort;
  storage: StoragePort;
  llm: LlmPort;
}): ComposeContext {
  const { registry, semantic, storage, llm } = args;
  const shared: Pick<ComposePolicy, "allowL2" | "l2Smoke" | "routeTier" | "designSystem"> = {
    allowL2: true,
    // Pre-delivery smoke validation of L2-generated HTML. After passing static lint, it runs in jsdom and sends
    // back to repair any output that does not reach ready() due to a runtime TypeError (crushing the client's boot-timeout blank screen before delivery).
    l2Smoke: createL2Smoke(),
    // Free-form requests (sales.custom) skip L1 and go directly to L2
    routeTier: (intent) => (intent.canonical === "sales.custom" ? "L2" : undefined),
    // Applying the design system to L2 free generation: presents the token vocabulary + style rules in the prompt,
    // and generated output is written with var(--kohaku-*) references (direct color literals are sent back for repair by the L2_RAW_COLOR lint).
    // Since the values are injected by the sandbox at render time, generated output stays theme-independent (SPEC-ENV-003).
    designSystem: SALES_DESIGN_SYSTEM,
  };
  /**
   * The EN/JA policy pair (selected per request by policyFor via session.locale).
   * EN is the historical default policy verbatim — its generatorVersion string, few-shot wiring, and
   * fixed specs are byte-identical to the single-policy era, so existing caches and goldens are untouched.
   * JA varies the prompt (outputLanguage + JA fixed specs), so its generatorVersion carries the "/ja"
   * token (the ComposePolicy contract: prompt-content changes must bump/vary generatorVersion — the
   * cache key itself has no language segment). JA omits fewShot: fixated few-shot examples are EN
   * specs and would bias JA generation toward English labels.
   */
  const policyByLang: Record<OutputLang, ComposePolicy> = {
    en: {
      ...shared,
      // Standard views are L0 fixed Specs (do not pass through the LLM). "App UI = the solidified form of L1".
      fixedSpecs: createFixedSpecs(),
      // Mix the generator version into the cache key. A prompt revision (PROMPT_REVISION) or model change separates
      // the cache of generated output by generation. The version that made few-shot on by default is PROMPT_REVISION="2".
      // "/ds2" is the designSystem version (bump when you change the content — the practice of separating prompt content changes by generation).
      generatorVersion: `${defaultGeneratorVersion(llm)}/ds2`,
      // few-shot self-reinforcement (3-9): supplies fixated (review-passed) Specs as models for L1 generation.
      // Deterministic (canonical match first -> the first 2 in intentHash ascending order). While there are 0 fixations
      // it returns an empty array and the generation prompt is byte-identical to the previous version (models increase gradually).
      fewShot: createFixationFewShot(storage),
    },
    ja: {
      ...shared,
      fixedSpecs: createFixedSpecs("ja"),
      outputLanguage: "Japanese",
      generatorVersion: `${defaultGeneratorVersion(llm)}/ds2/ja`,
    },
  };
  return {
    // Backward-compatibility field for the single (tenant-neutral) catalog path. Since compose preferentially uses
    // catalogFor it is rarely referenced in practice, but the getter always returns the latest base catalog (preventing drift after reconcile).
    get catalog() {
      return registry.componentCatalogFor(undefined);
    },
    // Per-tenant catalog resolution. compose / composeStream do generation, validation, and cache-key computation
    // with session.tenant's catalog (the fingerprint varies by tenant, so caches separate naturally).
    catalogFor: (tenant) => registry.componentCatalogFor(tenant),
    semantic,
    storage,
    llm,
    // The default policy for direct consumers that do not resolve a session (scripts, direct
    // compose calls) — EN. The MCP host resolves a per-tool-call session (locale argument) via policyFor.
    policy: policyByLang.en,
    // Per-session policy resolution: session.locale selects the language pair above (deterministic;
    // the JA policy's own generatorVersion carries the prompt-content variation, per the policyFor contract).
    policyFor: (session) => policyByLang[languageOf(session?.locale)],
    // Observability of the compose failure path (the demo is console-based). Logs L1/L2 deterministic fallback
    // degradation (the Spec is delivered but generation failed) and hard failure (Spec not delivered). Because of the
    // fire-and-forget contract (the composer side catches the throw), it does not affect compose's result or existing behavior.
    observer: composeObserver(),
  };
}

/**
 * The demo's console-based compose observer, optionally combined with @kohaku-ui/otel's OTel observer via
 * composer's composeObservers when `KOHAKU_OTEL=1` (opt-in; unset/any other value is a complete no-op --
 * this function returns the exact same object it always has, not merely an equivalent one, so default
 * behavior is provably unchanged). This package intentionally does NOT initialize an OTel SDK / exporter
 * (see docs/user-guide.md's "Trace context / OTel" section) -- with KOHAKU_OTEL=1 but no TracerProvider
 * registered by the host process, createOtelComposeObserver's tracer is a no-op (spans are created and
 * discarded), which is a harmless, fully-supported configuration.
 */
function composeObserver(): ComposeObserver {
  const consoleObserver: ComposeObserver = {
    onError: (errCtx, error) => {
      const intentLabel = errCtx.intent != null ? `(intent=${errCtx.intent.canonical})` : "";
      // correlationId is host-rest's X-Request-Id / MCP's tool-call JSON-RPC request id (threaded in via
      // ComposeOptions.correlationId — see composeForRest / composeForTool). Logging it lets an operator
      // grep this degradation log line back to the exact request that triggered it.
      const requestIdLabel = `(requestId=${errCtx.correlationId ?? "-"})`;
      if (errCtx.phase === "fallback") {
        console.warn(
          `[compose] ${errCtx.tier ?? "?"} generation failed and was degraded to the deterministic fallback${intentLabel}${requestIdLabel}: ${errCtx.reason ?? "reason unknown"}`,
        );
      } else {
        console.error(`[compose] compose failed (Spec not delivered)${intentLabel}${requestIdLabel}:`, error);
      }
    },
  };
  if (process.env.KOHAKU_OTEL !== "1") return consoleObserver;
  return composeObservers(consoleObserver, createOtelComposeObserver());
}
