import { assertKnownReservedParams, type QueryRef, splitReservedParams } from "@kohaku-ui/data-binding";
import type { JsonObject } from "@kohaku-ui/spec-core";

/**
 * A parsed read-ref, ready for both capability verification (against `base.raw`) and `domain.invoke`
 * (with `params`). Shared shape for the three read-ref sites that used to duplicate this parsing:
 * REST's /binding/resolve, MCP's `${prefix}_resolve_binding` tool, and MCP's initial-data preresolution
 * (packages/host-mcp-apps/src/initial-data.ts's resolveVariant).
 */
export interface InvokableRef {
  /**
   * The canonical base ref with reserved parameters (leading `_`) removed. `base.raw` is what capability
   * verification matches exactly (it equals the original Spec `$ref`, which never carries reserved params),
   * and `base.path` is the first `domain.invoke` argument.
   */
  base: QueryRef;
  /** Reserved parameters (`_cursor`/`_limit`/`_sort`/`_dir`) split out of the ref. */
  reserved: Record<string, string>;
  /**
   * `{ ...base.params, ...reserved }` in that order — the exact second argument every call site passes to
   * `domain.invoke` (the `_` namespace convention; DomainPort itself is unaware of reserved params).
   */
  params: JsonObject;
}

export type ParsedInvokableRef =
  | { kind: "ok"; ref: InvokableRef }
  | { kind: "source_mismatch"; source: string };

/**
 * Parses a `query://` ref into base/reserved/merged-params (via data-binding's splitReservedParams +
 * assertKnownReservedParams) and classifies whether its source matches the host's `querySource`.
 *
 * This is **pure parse/merge only** — no capability verification, no `domain.invoke` call, no error →
 * response mapping. Each call site (REST route, MCP tool, MCP initial-data preresolution) keeps its own
 * verify step (or, for initial-data, the deliberate absence of one) and its own error → status/toolError/
 * null mapping around this function; only the triplicated split/assert/merge/source-check moves here.
 *
 * Throws exactly what `splitReservedParams` (malformed `query://` URI) and `assertKnownReservedParams`
 * (an unknown `_`-prefixed key) throw, so callers that already catch those exceptions and turn them into a
 * 400 / tool error keep working unchanged.
 */
export function parseInvokableRef(ref: string, querySource: string): ParsedInvokableRef {
  const { base, reserved } = splitReservedParams(ref);
  assertKnownReservedParams(reserved);
  if (base.source !== querySource) {
    return { kind: "source_mismatch", source: base.source };
  }
  return { kind: "ok", ref: { base, reserved, params: { ...base.params, ...reserved } } };
}
