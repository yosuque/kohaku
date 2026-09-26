import type {
  CanonicalIntent,
  IntentInput,
  JsonObject,
  SemanticInput,
  SemanticPort,
  SessionContext,
} from "@kohaku-ui/spec-core";
import { finalizeIntent } from "@kohaku-ui/spec-core";

/**
 * The 3 request shapes that resolve into a CanonicalIntent across the compose/event surfaces: an
 * already-structured Intent (finalized as-is), a natural-language question (normalized then finalized), or a
 * GUI event delta, optionally against a `current` Intent (normalized then finalized).
 *
 * This is a narrower set than the full SemanticInput union: "nl" carries its own optional `locale` (mirroring
 * NLQuery.locale, forwarded to semantic.normalize when present — see the precedence note on `resolveIntent`
 * below), so REST's /intent/normalize and resolveIntentFromBody can route their "nl" and "intent" branches
 * through this helper without losing that field. "gui"'s `current` mirrors SemanticInput's GuiAction, where it
 * is likewise optional (a fresh gui action against no prior Intent omits it), so every SemanticInput shape —
 * including a currentless GuiAction — resolves through this one helper with no direct semantic.normalize
 * bypass needed at the call site.
 */
export type IntentSource =
  | { kind: "intent"; intent: IntentInput }
  | { kind: "nl"; text: string; locale?: string }
  | { kind: "gui"; current?: CanonicalIntent; action: string; params: JsonObject };

/**
 * Resolves and finalizes a CanonicalIntent from one of the 3 shapes above. Shared by the REST and MCP profiles
 * wherever a site's choreography matches exactly (REST's /events GUI delta, MCP's compose-tool nl/intent
 * branch).
 *
 * `current` is echoed back on the "gui" source for symmetry with the caller's own bookkeeping (e.g. /events'
 * recorder.interacted needs the pre-event Intent's hash; callers that already hold `current` locally can
 * ignore this return field).
 *
 * Takes `session` as given — it does not construct or unify SessionContext. The REST and MCP profiles build
 * theirs differently (e.g. whether a principal is attached), and this helper must not paper over that.
 *
 * Locale precedence for "nl": `source.locale` (mirroring NLQuery.locale) is forwarded to semantic.normalize
 * alongside `session.locale`; per-input locale winning over the session's is the SemanticPort
 * implementation's own concern (see apps/sample-api/src/ports/semantic-port.ts), not this helper's.
 *
 * "intent" validation: unlike "nl" / "gui", a directly-specified Intent never passes through
 * `semantic.normalize`, so when `semantic.validateIntent` is implemented it is called here before
 * `finalizeIntent` (rejecting an unknown canonical or invalid params before a fresh intentHash is ever
 * minted for them — see SemanticPort.validateIntent's doc comment in spec-core). A `semantic` without it
 * keeps the historical behavior of finalizing `source.intent` unchecked (backward compatible). Note this
 * only covers callers that route a directly-specified Intent through this helper (host-rest's /compose,
 * /events' `current`, and /fixations/approve; host-mcp-apps' compose-family tools and `${prefix}_event`'s
 * `current`) — a product calling `compose()` directly with a `{kind: "intent"}` ComposeInput bypasses this
 * helper entirely and is therefore unvalidated by design (see docs/design.md).
 */
export async function resolveIntent(
  semantic: Pick<SemanticPort, "normalize" | "validateIntent">,
  source: IntentSource,
  session: SessionContext,
): Promise<{ intent: CanonicalIntent; current?: CanonicalIntent }> {
  if (source.kind === "intent") {
    const validated =
      semantic.validateIntent != null ? await semantic.validateIntent(source.intent, session) : source.intent;
    return { intent: await finalizeIntent(validated) };
  }
  if (source.kind === "nl") {
    const normalized = await semantic.normalize(
      { kind: "nl", text: source.text, ...(source.locale != null ? { locale: source.locale } : {}) },
      session,
    );
    return { intent: await finalizeIntent(normalized) };
  }
  const input: SemanticInput = {
    kind: "gui",
    action: source.action,
    params: source.params,
    ...(source.current != null ? { current: source.current } : {}),
  };
  const normalized = await semantic.normalize(input, session);
  return {
    intent: await finalizeIntent(normalized),
    ...(source.current != null ? { current: source.current } : {}),
  };
}
