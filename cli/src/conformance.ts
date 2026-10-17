import {
  buildReport,
  type ConformanceReport,
  formatReport,
  runRestSuite,
  runSpecFormatSuite,
} from "@kohaku-ui/spec/conformance";
import { errorMessage } from "./error-message.js";

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
      `Cannot parse the --intent JSON (${errorMessage(e)}). Example: --intent '{"canonical":"sales.trend","params":{}}'`,
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
    const cause = errorMessage(e);
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
