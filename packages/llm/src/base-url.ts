import type { LlmProvider } from "./env.js";

/**
 * The API-version path segment each vendor SDK treats as part of its own endpoint, for the providers whose
 * `KOHAKU_LLM_BASE_URL` is the *vendor root* (no version path). openai / ollama / llama follow the
 * OpenAI-compatible convention instead (the value includes `/v1` and is used as-is).
 */
const VERSION_SEGMENT: Partial<Record<LlmProvider, string>> = {
  claude: "/v1",
  gemini: "/v1beta",
};

/**
 * Normalises `KOHAKU_LLM_BASE_URL` to the provider's *vendor root*, so that `https://gw.example` and
 * `https://gw.example/v1` (claude) or `…/v1beta` (gemini) name the same endpoint in both language ports.
 *
 * - An unset, empty or whitespace-only value returns `undefined` (use the SDK's default endpoint).
 * - claude / gemini: trailing slashes and one trailing version segment (`/v1` / `/v1beta`) are stripped.
 *   The TypeScript provider SDKs want the versioned base, so the adapter re-appends it
 *   (see {@link versionedBaseUrl}); the Python SDKs add the version themselves and take the root as-is.
 * - openai / ollama / llama: returned trimmed and otherwise unchanged.
 *
 * Pinned across languages by `spec/test/fixtures/cross-language-canonical.json` (`llmBaseUrl`).
 */
export function normalizeVendorBaseUrl(
  provider: LlmProvider,
  baseUrl: string | undefined,
): string | undefined {
  const trimmed = baseUrl?.trim();
  if (trimmed == null || trimmed === "") return undefined;
  const segment = VERSION_SEGMENT[provider];
  if (segment == null) return trimmed;
  let root = stripTrailingSlashes(trimmed);
  if (root.endsWith(segment)) root = stripTrailingSlashes(root.slice(0, -segment.length));
  return root === "" ? undefined : root;
}

/**
 * Removes every trailing `/` in linear time. A `/\/+$/` regex would backtrack quadratically on an input with
 * many slashes that do not reach the end of the string (CodeQL js/polynomial-redos), and the value comes from
 * configuration a library caller passes in.
 */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

/**
 * The `baseURL` to hand a TypeScript provider SDK: the normalised vendor root plus the version segment that
 * SDK expects (claude `/v1`, gemini `/v1beta`), or the OpenAI-compatible value unchanged. `undefined` when
 * unset, so the SDK keeps its default endpoint.
 */
export function versionedBaseUrl(provider: LlmProvider, baseUrl: string | undefined): string | undefined {
  const root = normalizeVendorBaseUrl(provider, baseUrl);
  if (root == null) return undefined;
  const segment = VERSION_SEGMENT[provider];
  return segment == null ? root : `${root}${segment}`;
}
