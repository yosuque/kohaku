import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createKohakuClient, type ExplainReport, type Transport } from "@kohaku-ui/client";
import { collectScriptSyntaxIssues } from "@kohaku-ui/composer";
import { exportDistillationDataset } from "@kohaku-ui/evals";
import { createL2Smoke } from "@kohaku-ui/sandbox/smoke";
import {
  buildReport,
  type ConformanceReport,
  formatReport,
  runRestSuite,
  runSpecFormatSuite,
} from "@kohaku-ui/spec/conformance";
import {
  type DataShape,
  type FixationRecord,
  FixationRecordSchema,
  type UISpec,
  UISpecSchema,
} from "@kohaku-ui/spec-core";
import semver from "semver";
import {
  GOLDEN_README_TEMPLATE,
  GOLDEN_TEST_TEMPLATE,
  INTENTS_TEMPLATE,
  PORTS_TEMPLATE,
  SERVER_TEMPLATE,
} from "./templates.js";

/** conformance --self: self-check of the Spec format */
export async function runSelfConformance(): Promise<ConformanceReport> {
  return buildReport(await runSpecFormatSuite());
}

export interface ComposeIntentArg {
  canonical: string;
  params: Record<string, unknown>;
}

const DEFAULT_COMPOSE_INTENT: ComposeIntentArg = {
  canonical: "sales.quarterly_summary",
  params: { fiscalYear: 2026, quarter: 3, groupBy: "region" },
};

/**
 * Parse the --intent JSON with validation.
 * Silently forwarding a malformed shape (missing canonical, non-object params) to the host produces
 * hard-to-trace failures such as 422, so we reject it at the CLI boundary and point to the next action.
 */
export function parseIntentArg(json: string): ComposeIntentArg {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Cannot parse the --intent JSON (${e instanceof Error ? e.message : String(e)}). Example: --intent '{"canonical":"sales.trend","params":{}}'`,
    );
  }
  const obj = parsed as Record<string, unknown> | null;
  if (
    obj == null ||
    typeof obj !== "object" ||
    typeof obj["canonical"] !== "string" ||
    obj["canonical"] === "" ||
    typeof obj["params"] !== "object" ||
    obj["params"] == null ||
    // Arrays are also typeof === "object", so reject them explicitly with Array.isArray.
    // Letting an array through as a Record makes the return type a lie; rest-host's spread (...params)
    // would then turn it into numeric keys reaching the host, producing a hard-to-trace failure.
    Array.isArray(obj["params"])
  ) {
    throw new Error('--intent must be given in the form {"canonical": "...", "params": {...}}');
  }
  return { canonical: obj["canonical"], params: obj["params"] as Record<string, unknown> };
}

/**
 * Probe the host once before running the full black-box suite. Without this, an unreachable host (the
 * common case: forgot to start it) makes every one of the suite's dozen-plus checks fail on the same
 * underlying "fetch failed", drowning the actual cause in repetition. A single upfront `GET /catalog`
 * (SPEC REST-CAT-001, unauthenticated and side-effect-free) turns that into one clear line.
 */
async function checkReachable(base: string, baseUrl: string): Promise<void> {
  try {
    await fetch(`${base}/catalog`);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Cannot reach ${baseUrl} (${cause}). Is the host running? (pnpm dev / cd python && uv run python -m sales_api)`,
    );
  }
}

/** conformance --rest <baseUrl>: black-box check of a REST host */
export async function runRestConformance(baseUrl: string, intentJson?: string): Promise<ConformanceReport> {
  const composeIntent = intentJson != null ? parseIntentArg(intentJson) : DEFAULT_COMPOSE_INTENT;
  const base = baseUrl.replace(/\/$/, "");
  await checkReachable(base, baseUrl);
  const results = await runRestSuite({
    fetch: (path, init) => fetch(`${base}${path}`, init),
    composeIntent,
  });
  return buildReport([...(await runSpecFormatSuite()), ...results]);
}

export { formatReport };

/** Options for `kohaku explain <requestId>`. */
export interface ExplainOptions {
  /** REST host base URL (e.g. http://localhost:8787/api/kohaku). */
  rest: string;
  /** Extra request headers as "name:value" strings (repeatable --header flag; commonly tenant/auth headers). */
  headers?: string[];
  /** Path to a UISpec JSON file. When given, the report's `scopes` field is populated (collectCapabilityScopes). */
  specPath?: string;
  /**
   * Transport override (no CLI flag exposes this). Symmetric with KohakuClientConfig.transport: exists so
   * tests can inject an in-process Hono app's `app.request` instead of a real network fetch. Defaults to the
   * client SDK's own default (the global fetch) when omitted, which is what every real CLI invocation gets.
   */
  transport?: Transport;
}

/**
 * Parses repeated `--header name:value` flags into a headers record. Throws on a malformed entry (no `:`, or
 * an empty name) so a typo is caught at the CLI boundary rather than silently sending a broken header.
 */
export function parseHeaderArgs(headers: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const idx = h.indexOf(":");
    if (idx <= 0) {
      throw new Error(`--header must be given as "name:value" (got "${h}")`);
    }
    out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return out;
}

/**
 * `kohaku explain <requestId>`: fetches every lineage event recorded under `requestId`'s correlationId from
 * a REST host and builds an ExplainReport (@kohaku-ui/client's buildExplainReport, via KohakuClient.explain).
 * When `opts.specPath` is given, the file is parsed and validated as a UISpec (UISpecSchema) so the report's
 * `scopes` field can be computed -- a malformed file is rejected here with a clear message rather than
 * reaching collectCapabilityScopes with an untyped value.
 */
export async function runExplain(requestId: string, opts: ExplainOptions): Promise<ExplainReport> {
  const headers = parseHeaderArgs(opts.headers);
  const client = createKohakuClient({
    baseUrl: opts.rest.replace(/\/$/, ""),
    headers: () => headers,
    ...(opts.transport != null ? { transport: opts.transport } : {}),
  });
  let spec: UISpec | undefined;
  if (opts.specPath != null) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(opts.specPath, "utf8"));
    } catch (e) {
      throw new Error(
        `Cannot read/parse --spec ${opts.specPath} (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    spec = UISpecSchema.parse(raw);
  }
  return client.explain(requestId, spec != null ? { spec } : undefined);
}

/** Right-pads a label to a fixed column width for formatExplainReport's aligned key/value lines. */
function label(text: string, width = 20): string {
  return text.length >= width ? `${text}: ` : `${text}:${" ".repeat(width - text.length)}`;
}

/**
 * Formats an ExplainReport as human-readable text: `kohaku explain`'s default output (the non-`--json`
 * path). Renders provenance, the cache-key breakdown, the decision flow, capability scopes (when present),
 * and the raw lineage events -- in that order, matching the brief's "tier, cache, cache-key breakdown,
 * decision flow, related lineage events" acceptance criterion.
 */
export function formatExplainReport(report: ExplainReport): string {
  const lines: string[] = [];
  if (report.composes.length === 0) {
    lines.push("No view.composed event found for this requestId.");
    lines.push(
      "Check that the host has a lineage recorder wired (createKohakuHost does by default; a hand-built " +
        "createKohakuRoutes host needs `recorder`), and that this is the requestId of a compose response. " +
        "Events recorded before correlationId support shipped have none and will never match; " +
        "see docs/user-guide.md's DevTools section.",
    );
  }
  report.composes.forEach((c, i) => {
    if (report.composes.length > 1) {
      lines.push(`--- compose ${i + 1}/${report.composes.length} (a reused requestId) ---`);
    }
    lines.push(`${label("Intent")}${c.canonical} (${c.intentHash})`);
    lines.push(
      `${label("Tier / cache")}${c.tier} / ${c.cache}${c.model != null ? ` (model: ${c.model})` : ""}`,
    );
    if (c.generatorVersion != null) lines.push(`${label("Generator")}${c.generatorVersion}`);
    if (c.kit != null) lines.push(`${label("Design kit")}${c.kit.id}@${c.kit.version}`);
    if (c.fallback != null) {
      lines.push(
        `${label("Fallback")}${c.fallback.from} (${c.fallback.kind ?? "generation"}): ${c.fallback.reason}`,
      );
    }
    if (c.cacheKey != null) {
      lines.push(`${label("Cache key")}${c.cacheKey}`);
      if (c.cacheKeyParts != null) {
        const p = c.cacheKeyParts;
        lines.push(
          `${label("  specVersion")}${p.specVersion ?? "-"}`,
          `${label("  intentHash")}${p.intentHash}`,
          `${label("  dataVersion")}${p.dataVersion}`,
          `${label("  catalogFingerprint")}${p.catalogFingerprint ?? "-"}`,
          `${label("  generatorVersion")}${p.generatorVersion ?? "-"}`,
          `${label("  policyFingerprint")}${p.policyFingerprint ?? "-"}`,
        );
      }
    }
    if (c.decision != null) {
      lines.push("Decision:");
      for (const a of c.decision.attempts) {
        lines.push(
          `  ${a.kind} attempt: ${a.ok ? "ok" : "failed"}${a.issues != null ? ` -- ${a.issues.join("; ")}` : ""}`,
        );
      }
      for (const d of c.decision.downgrades ?? []) {
        lines.push(`  downgrade: ${d.id} ${d.from} -> ${d.to} (${d.reason})`);
      }
      if (c.decision.coalesced === true) {
        lines.push("  coalesced: rode along on another compose under single-flight");
      }
      if (c.decision.usage != null) {
        lines.push(
          `  usage: ${c.decision.usage.inputTokens} input / ${c.decision.usage.outputTokens} output tokens`,
        );
      }
    }
  });
  if (report.scopes != null) {
    lines.push(`Capability scopes (${report.scopes.length}):`);
    for (const s of report.scopes) lines.push(`  ${s.kind}: ${s.ref}`);
  }
  lines.push(`Lineage events (${report.events.length}):`);
  for (const e of report.events) lines.push(`  ${e.ts}  ${e.type}  ${e.id}`);
  return lines.join("\n");
}

/**
 * Generate the scaffold files atomically (check-all-then-write).
 * Atomicity is required to honor "never overwrite". Checking existence while writing would, in a
 * directory where only one of the files already exists, leave the other partially generated. So we
 * check every file's existence first (check-all) and only then write (then-write). We create each
 * parent directory on demand so that placement in subdirectories is also allowed.
 */
export function writeScaffold(files: readonly (readonly [string, string])[]): string[] {
  for (const [path] of files) {
    if (existsSync(path)) {
      throw new Error(`${path} already exists (will not overwrite)`);
    }
  }
  const written: string[] = [];
  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(path);
  }
  return written;
}

/** scaffold ports: generate scaffolds for the DomainPort, an Intent catalog, and a Hono server built on createKohakuHost() */
export function scaffoldPorts(outDir: string): string[] {
  return writeScaffold([
    [join(outDir, "ports.ts"), PORTS_TEMPLATE],
    [join(outDir, "intents.ts"), INTENTS_TEMPLATE],
    [join(outDir, "server.ts"), SERVER_TEMPLATE],
  ]);
}

/**
 * scaffold golden: generate the Golden Spec regression scaffold.
 * Atomically places golden.test.ts (runGolden wiring + update-procedure comments) and golden/README.md
 * (the fixture format). The user adds fixtures (*.json), and the expected specs are generated with KOHAKU_GOLDEN_UPDATE=1.
 */
export function scaffoldGolden(outDir: string): string[] {
  return writeScaffold([
    [join(outDir, "golden.test.ts"), GOLDEN_TEST_TEMPLATE],
    [join(outDir, "golden", "README.md"), GOLDEN_README_TEMPLATE],
  ]);
}

/**
 * Input for the smoke-l2 subcommand (stdin JSON).
 * A sidecar contract that lets the Python implementation, which has no JS runtime, reuse the
 * TS validation logic in a "Node co-located environment". lint is the <script> syntax check, smoke is the
 * ready-reached check under jsdom execution.
 */
export interface SmokeL2Input {
  /** The L2-generated HTML to validate (a single HTML document). */
  html: string;
  /** Synthetic data source for smoke mode. Unused in lint. */
  shape?: DataShape;
  /** lint = <script> syntax check only / smoke = ready-reached check under jsdom execution. */
  mode: "lint" | "smoke";
  /** Upper bound (ms) for waiting on ready in smoke mode. Defaults to createL2Smoke's default (1000) when omitted. */
  readyTimeoutMs?: number;
}

/** Output of the smoke-l2 subcommand (stdout JSON). A non-empty issues list is sent back for repair. */
export interface SmokeL2Output {
  issues: string[];
}

/**
 * Parse the smoke-l2 stdin JSON with validation. A malformed shape is rejected with a single-line error (the sidecar's exit 1).
 */
export function parseSmokeL2Input(json: string): SmokeL2Input {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Cannot parse the smoke-l2 stdin JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const obj = parsed as Record<string, unknown> | null;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("The smoke-l2 input must be a JSON object");
  }
  if (typeof obj["html"] !== "string") {
    throw new Error("The smoke-l2 input html must be a string");
  }
  if (obj["mode"] !== "lint" && obj["mode"] !== "smoke") {
    throw new Error('The smoke-l2 input mode must be "lint" or "smoke"');
  }
  const readyTimeoutMs = obj["readyTimeoutMs"];
  if (readyTimeoutMs != null && (typeof readyTimeoutMs !== "number" || !Number.isFinite(readyTimeoutMs))) {
    throw new Error("The smoke-l2 input readyTimeoutMs must be a number");
  }
  const shape = obj["shape"];
  if (shape != null && (typeof shape !== "object" || Array.isArray(shape))) {
    throw new Error("The smoke-l2 input shape must be a DataShape object");
  }
  return {
    html: obj["html"],
    mode: obj["mode"],
    ...(shape != null ? { shape: shape as DataShape } : {}),
    ...(readyTimeoutMs != null ? { readyTimeoutMs: readyTimeoutMs as number } : {}),
  };
}

/**
 * The smoke-l2 validation core. lint reuses composer's syntax-check part, and smoke reuses sandbox's jsdom
 * smoke (avoiding a duplicate implementation of the validation logic and keeping the TS side the single source of truth).
 * lint does not run the lexical-lint items (hallucinated APIs, missing ready, etc.) — the Python side has its own,
 * so from TS we borrow only the check part that requires JS execution.
 */
export async function runSmokeL2(input: SmokeL2Input): Promise<SmokeL2Output> {
  if (input.mode === "lint") {
    return { issues: collectScriptSyntaxIssues(input.html) };
  }
  const smoke = createL2Smoke(input.readyTimeoutMs != null ? { readyTimeoutMs: input.readyTimeoutMs } : {});
  const issues = await smoke(input.html, input.shape != null ? { shape: input.shape } : {});
  return { issues };
}

export interface ComponentValidationIssue {
  field: string;
  message: string;
}

/** component validate: validate a ComponentDefinition (JSON-serialized form) */
export function validateComponentFile(path: string): ComponentValidationIssue[] {
  const issues: ComponentValidationIssue[] = [];
  let def: Record<string, unknown>;
  try {
    def = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    // As on the index.ts side, stringify non-Error values with String(e) (unified error formatting).
    return [
      { field: "(file)", message: `Cannot read as JSON: ${e instanceof Error ? e.message : String(e)}` },
    ];
  }

  if (
    typeof def["type"] !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/.test(def["type"])
  ) {
    issues.push({ field: "type", message: "A dot-separated identifier is required" });
  }
  if (typeof def["version"] !== "string" || semver.valid(def["version"]) == null) {
    issues.push({ field: "version", message: "A valid semver is required" });
  }
  if (typeof def["description"] !== "string" || def["description"].trim() === "") {
    issues.push({
      field: "description",
      message: "Selection guidance for the LLM (description) is required",
    });
  }
  const props = def["propsSchema"];
  if (props == null || typeof props !== "object") {
    issues.push({ field: "propsSchema", message: "A JSON Schema object is required" });
  } else if ((props as { type?: string }).type !== "object") {
    issues.push({ field: "propsSchema", message: 'propsSchema.type must be "object"' });
  }
  const caps = def["capabilities"] as { data?: string } | undefined;
  if (caps == null || !["none", "optional", "required"].includes(caps.data ?? "")) {
    issues.push({ field: "capabilities.data", message: "one of none | optional | required is required" });
  }
  return issues;
}

export interface ExportDatasetOptions {
  /** A fixations.json snapshot (StoragePort's on-disk shape: {key -> FixationRecord}; see storage-port.ts). */
  fixationsPath: string;
  /** A directory of golden fixture JSON files ({name, input, drafts, expected} — see the `scaffold golden` template) or plain UISpec JSON files. */
  goldenDir?: string;
  outPath: string;
  /**
   * Restrict the export to fixations owned by this tenant. Without it, the output spans every tenant
   * present in `fixationsPath` (the on-disk snapshot legitimately holds one record per (tenant,
   * intentHash) for several tenants side by side; see storage-port.ts).
   */
  tenant?: string;
}

export interface ExportDatasetResult {
  fixations: number;
  golden: number;
  outPath: string;
  /** Number of entries in `fixationsPath` that failed FixationRecordSchema and were skipped (see exportDataset's doc comment). */
  skipped: number;
}

/**
 * Reads one golden-fixture-shaped JSON file (`{name, input, drafts, expected}`, from `scaffold golden`) or
 * a plain UISpec JSON file, and returns its Spec. Returns null for a fixture whose `expected` has not been
 * generated yet (`expected: null`) — silently skipped rather than treated as an error, since that is the
 * fixture's normal pre-generation state (see GOLDEN_README_TEMPLATE).
 */
function loadGoldenSpec(path: string): UISpec | null {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const isObject = raw != null && typeof raw === "object" && !Array.isArray(raw);
  const candidate =
    isObject && "expected" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>)["expected"]
      : raw;
  if (candidate == null) return null;
  const parsed = UISpecSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`${path} does not contain a valid UISpec (${parsed.error.message})`);
  }
  return parsed.data;
}

/**
 * dataset export: reads a fixations.json snapshot (sample-api's `.data/fixations.json` can be passed
 * directly) plus optional golden Specs from a directory, and writes the JSONL distillation dataset via
 * @kohaku-ui/evals's exportDistillationDataset (fixated Specs are the best available teacher data
 * for a distilled model, since a human already approved them).
 *
 * Fail-open on a per-entry basis: an entry that fails FixationRecordSchema is skipped (reported on
 * stderr and counted in the result's `skipped`) rather than aborting the whole export. This matches the
 * runtime read path (a record that fails validation is treated as "no fixation", falling back to a fresh
 * compose) — a fail-closed export would otherwise let one hand-edited or pre-migration record block the
 * entire dataset. A top-level shape that is not an object still throws (there is no per-entry recovery
 * from that).
 */
export function exportDataset(options: ExportDatasetOptions): ExportDatasetResult {
  if (!existsSync(options.fixationsPath)) {
    throw new Error(
      `${options.fixationsPath} does not exist. Approve a fixation first (in the sample, it appears under ` +
        `the runtime state directory's fixations.json once one exists).`,
    );
  }
  const rawFixations: unknown = JSON.parse(readFileSync(options.fixationsPath, "utf8"));
  if (rawFixations == null || typeof rawFixations !== "object" || Array.isArray(rawFixations)) {
    throw new Error(
      `${options.fixationsPath} must be a JSON object (the on-disk fixations.json shape: {key -> FixationRecord})`,
    );
  }
  const fixations: FixationRecord[] = [];
  let skipped = 0;
  for (const [key, value] of Object.entries(rawFixations as Record<string, unknown>)) {
    const parsed = FixationRecordSchema.safeParse(value);
    if (!parsed.success) {
      process.stderr.write(
        `dataset export: skipped "${key}" (not a valid FixationRecord: ${parsed.error.message})\n`,
      );
      skipped++;
      continue;
    }
    fixations.push(parsed.data);
  }

  let golden: UISpec[] | undefined;
  if (options.goldenDir != null) {
    golden = [];
    for (const file of readdirSync(options.goldenDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const spec = loadGoldenSpec(join(options.goldenDir, file));
      if (spec != null) golden.push(spec);
    }
  }

  const jsonl = exportDistillationDataset(
    { fixations, ...(golden != null ? { golden } : {}) },
    { tenant: options.tenant },
  );
  const includedFixations =
    options.tenant != null ? fixations.filter((r) => r.tenant === options.tenant).length : fixations.length;
  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, jsonl);
  return { fixations: includedFixations, golden: golden?.length ?? 0, outPath: options.outPath, skipped };
}
