import type { JsonObject } from "@kohaku-ui/spec-core";

/**
 * Side-effect declaration of the write (annotate). Shared by the REST side (/binding/action) and the MCP side
 * (kohaku_action) (same-shape signature as host-rest's KohakuHostDeps.actionEffects / host-mcp-apps's
 * McpHostDeps.actionEffects). The single source of truth so the implementation is not duplicated in app.ts and sample-mcp's setup.ts.
 *
 * annotate advances the data version, so it invalidates the displayed references indicated by payload.refs with the
 * new version (a distant table re-resolves in place and does not go STALE = the small loop of the write loop).
 * A non-target action has no side effect (only { result }).
 */
export async function salesActionEffects(
  action: string,
  payload: JsonObject,
  result: unknown,
): Promise<{ invalidates?: string[]; refVersions?: Record<string, string> }> {
  if (action !== "annotate") return {};
  const refs = extractRefs(payload);
  const dataVersion = (result as { dataVersion?: unknown } | null)?.dataVersion;
  if (refs.length === 0 || typeof dataVersion !== "string") return { invalidates: refs };
  return {
    invalidates: refs,
    refVersions: Object.fromEntries(refs.map((r) => [r, dataVersion])),
  };
}

/** Safely extracts the invalidation-target query:// URIs (payload.refs) from the write payload. */
function extractRefs(payload: JsonObject): string[] {
  const refs = payload["refs"];
  if (!Array.isArray(refs)) return [];
  return refs.filter((r): r is string => typeof r === "string");
}
