import type { JsonObject } from "@kohaku-ui/spec-core";

/** Optional side-effect declaration a host wires for its write-through path (REST's /binding/action, MCP's `${prefix}_action`). */
export type ActionEffects = (
  action: string,
  payload: JsonObject,
  result: unknown,
) => Promise<{ invalidates?: string[]; refVersions?: Record<string, string> }>;

export interface ActionEffectsResponse {
  result: unknown;
  invalidates?: string[];
  refVersions?: Record<string, string>;
}

/**
 * Shapes the post-write response for the write-through path (REST's /binding/action, MCP's `${prefix}_action`).
 * The write (domain.invoke) is already committed by the time this runs, which is why this is fail-open: the side-effect declaration
 * (actionEffects) is a "declaration", not the write itself, so turning its failure into a client-visible error
 * would make the client resend and could duplicate a non-idempotent write. An actionEffects failure is
 * therefore reported via onEffectsError and swallowed (never thrown), and the response still succeeds with
 * `{ result }` only (the backward-compatible shape both hosts' clients already parse).
 */
export async function applyActionEffects(
  actionEffects: ActionEffects | undefined,
  action: string,
  payload: JsonObject,
  result: unknown,
  onEffectsError: (error: unknown) => void | Promise<void>,
): Promise<ActionEffectsResponse> {
  let effects: { invalidates?: string[]; refVersions?: Record<string, string> } = {};
  try {
    effects = (await actionEffects?.(action, payload, result)) ?? {};
  } catch (e) {
    await onEffectsError(e);
  }
  return {
    result: result ?? null,
    ...(effects.invalidates != null ? { invalidates: effects.invalidates } : {}),
    ...(effects.refVersions != null ? { refVersions: effects.refVersions } : {}),
  };
}
