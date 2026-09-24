/**
 * Operator tool: measures whether Anthropic's structured-output grammar compilation adds a measurable
 * latency tax under kohaku's default `ComposePolicy.refConstraint = "schema"` (an intent-specific
 * `data.$ref` enum — a distinct output grammar per Intent) versus `"validate"` (a plain string field,
 * checked explicitly after generation instead — an intent-independent grammar). See SPEC.md's
 * CMP-GEN-001 and docs/design.md §5 for the full trade-off this is meant to inform.
 *
 * What is actually timed: each row's `ms` brackets the **whole `compose()` call** — semantic-port
 * resolution (query execution) and post-generation validation included, not just the LLM request/response
 * itself. Treat the numbers as an upper bound on the grammar-compile effect, not a clean isolation of it.
 *
 * This calls a real LLM (KOHAKU_LLM_PROVIDER=claude), so it is intentionally **not** part of `pnpm test`
 * (never call an LLM from a test — see AGENTS.md) and must be run manually:
 *
 *   KOHAKU_LLM_PROVIDER=claude KOHAKU_LLM_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=... \
 *     pnpm --filter @kohaku-ui-sample/api run measure-grammar-latency
 *
 * For each of 3 representative Intents x both refConstraint modes, composes **twice in a row** with
 * `cacheMode: "bypass"` (so the 2nd call still reaches the LLM instead of short-circuiting on kohaku's own
 * Spec cache). All 12 calls share one StoragePort / temp dir (only kohaku's own Spec cache is bypassed;
 * lineage state is otherwise irrelevant to this measurement, so there is no need for per-combination
 * isolation there). Prints each call's latency, `provenance.cache` (which should read "bypass" for every
 * row here — that is expected, and confirms the timing reflects a real compose rather than a Spec-cache
 * hit; a different value, or a "fallback"/degraded tier, means the LLM path did not actually run and the
 * latency numbers are meaningless for this measurement), and the repair-attempt count
 * (`trace.attempts.length`) as a table.
 *
 * How to read the table: Anthropic caches a compiled structured-output grammar for 24h, keyed on the
 * grammar's own shape. That means the 1st-vs-2nd call of the SAME intent does NOT separate the two modes —
 * under "schema" the 2nd call already hits Anthropic's own grammar cache (same intent = same enum = same
 * compiled grammar), so it does not pay a second compile either. What actually separates the two modes is
 * the FIRST attempt of the 2nd and 3rd intents: under "validate" every intent shares one intent-independent
 * grammar, so by the time the 2nd intent's first attempt runs, the grammar already compiled for the 1st
 * intent is reused; under "schema" each intent's `data.$ref` enum differs, so the 2nd and 3rd intents'
 * first attempts each force a fresh compile. Compare THOSE rows (intent 2 & 3, attempt 1) across modes, not
 * the two attempts of the same intent. Also check the `attempts` column: under "validate", an out-of-set
 * `data.$ref` is only caught by post-generation validation and costs a second LLM call (a repair
 * re-attempt) to fix — a row with attempts > 1 has spent extra LLM round-trips that "schema" mode's
 * up-front enum constraint would have avoided, and that extra time is not grammar-compile latency at all.
 *
 * This script only measures; it does not change any default. Decide whether to flip
 * ComposePolicy.refConstraint's default only after running this against the actual target model/provider.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposeContext, type ComposePolicy, compose } from "@kohaku-ui/composer";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { coreCatalog, resolveCatalog } from "@kohaku-ui/registry";
import type { JsonObject } from "@kohaku-ui/spec-core";
import { createFileStoragePort } from "@kohaku-ui/storage-memory";
import { salesContribution } from "../src/catalog/contribution.js";
import { SalesRepo } from "../src/domain/repo.js";
import { IntentCatalog } from "../src/intents/catalog.js";
import { createSemanticPort } from "../src/ports/semantic-port.js";

/**
 * 3 representative Intents (full explicit params — `kind: "intent"` composes bypass the GUI/NL
 * default-filling `finalizeIntent` would otherwise apply, so every param each Intent's query builder
 * reads must be given directly).
 */
const INTENTS: { canonical: string; params: JsonObject }[] = [
  { canonical: "sales.quarterly_summary", params: { fiscalYear: 2026, quarter: 3, groupBy: "region" } },
  { canonical: "sales.trend", params: { fiscalYear: 2026, metric: "revenue", granularity: "month" } },
  { canonical: "sales.by_product", params: { fiscalYear: 2026, quarter: 3, metric: "revenue", topN: 5 } },
];

const REF_CONSTRAINTS: ComposePolicy["refConstraint"][] = ["schema", "validate"];

interface Row {
  intent: string;
  refConstraint: string;
  attempt: number;
  ms: number;
  cache: string;
  tier: string;
  attempts: number;
}

async function main(): Promise<void> {
  const llm = createLlmFromEnv();
  if (llm.provider !== "claude") {
    console.error(
      `This script measures Anthropic-specific structured-output grammar caching; got provider "${llm.provider}". ` +
        "Set KOHAKU_LLM_PROVIDER=claude.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Provider: ${llm.provider} / model: ${llm.modelId}\n`);

  const repo = new SalesRepo();
  const intentCatalog = new IntentCatalog();
  const catalog = resolveCatalog(coreCatalog, salesContribution);
  const semantic = createSemanticPort({ repo, catalogFor: () => intentCatalog, llm });

  // One shared temp dir / StoragePort for every (intent, refConstraint) combination in this run. Only
  // kohaku's own Spec cache matters to this measurement, and every call below already sets
  // `cacheMode: "bypass"` to skip it — so combinations do not need isolated storage from one another, and
  // there is no reason to leave behind one temp directory per combination.
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-measure-grammar-"));
  const storage = createFileStoragePort(dataDir);

  const rows: Row[] = [];

  for (const { canonical, params } of INTENTS) {
    for (const refConstraint of REF_CONSTRAINTS) {
      const ctx: ComposeContext = {
        catalog,
        semantic,
        storage,
        llm,
        policy: {
          allowL2: false,
          // Bypass the Spec cache so the 2nd call still reaches the LLM (otherwise it would be a
          // near-zero-latency cache hit and tell us nothing about grammar-compile latency).
          cacheMode: "bypass",
          refConstraint,
        },
      };
      for (let attempt = 1; attempt <= 2; attempt++) {
        const startedAt = Date.now();
        const { trace } = await compose({ kind: "intent", intent: { canonical, params } }, ctx);
        const ms = Date.now() - startedAt;
        rows.push({
          intent: canonical,
          refConstraint: refConstraint ?? "schema",
          attempt,
          ms,
          cache: trace.cache,
          tier: trace.tier,
          attempts: trace.attempts.length,
        });
        console.log(
          `${canonical.padEnd(24)} refConstraint=${(refConstraint ?? "schema").padEnd(9)} attempt=${attempt} ${String(ms).padStart(6)}ms cache=${trace.cache} tier=${trace.tier} attempts=${trace.attempts.length}`,
        );
      }
    }
  }

  console.log("\nSummary:");
  console.table(rows);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
