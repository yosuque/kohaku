import type { IntentInput } from "../intent.js";
import type { CanonicalIntent } from "../schema/intent.js";
import type { JsonObject } from "../schema/json.js";
import type { DataShape } from "../tabular.js";
import type { SessionContext } from "./domain.js";

export type NLQuery = { kind: "nl"; text: string; locale?: string };
export type GuiAction = {
  kind: "gui";
  action: string;
  params: JsonObject;
  /** For an operation against an existing view, the Intent before the operation (the base for applying the diff). */
  current?: CanonicalIntent;
};
export type SemanticInput = NLQuery | GuiAction;

/** A data reference placed on a UI Spec. Bulk data is fetched by the component directly from the API. */
export interface QueryHandle {
  uri: string; // "query://source/path?params"
}

/**
 * Resolution of a normalized Intent → a deterministic query (the semantic-layer connection point).
 *
 * Tenant invariant: keep `query://` references tenant-neutral. Tenant data filtering is done by
 * DomainPort.invoke via InvocationContext.principal / capability, and resolveQuery / dataVersion do not
 * depend on the tenant. Therefore tenant is not included in the cache key, and Specs with the same
 * structure share the cache across tenants (any per-tenant catalog contribution separates them
 * naturally via catalogFingerprint).
 */
export interface SemanticPort {
  /**
   * Normalizes NL / GUI input. Returns an IntentInput without computing the hash: computing the
   * deterministic hash is the framework's responsibility (finalizeIntent), so implementers are not
   * forced to produce a dummy hash.
   */
  normalize(input: SemanticInput, ctx: SessionContext): Promise<IntentInput>;
  /**
   * Resolves a normalized Intent into a deterministic query (a reference-passing handle).
   * ctx.tenant (optional): because Intents added by promotion (publish) are independent per
   * tenant, it is used to look up per-tenant Intent definitions. query:// itself is tenant-neutral (the
   * invariant), so the URI of the returned QueryHandle does not depend on the tenant. Implementations
   * that ignore ctx (single-tenant) stay compatible as-is.
   */
  resolveQuery(intent: CanonicalIntent, ctx?: { tenant?: string }): Promise<QueryHandle | QueryHandle[]>;
  dataVersion(handle: QueryHandle): Promise<string>;
  /** Returns only column metadata (no row data). Used for chart-kind rules and props filling. */
  describeShape?(handle: QueryHandle): Promise<DataShape>;
  /**
   * Validates and normalizes a directly-specified Intent (the `kind: "intent"` path of host-core's
   * resolveIntent). Unlike `normalize`, which derives an Intent from NL/GUI input, this path lets a caller
   * hand over an already-structured Intent, which by construction never passes through `normalize` (or
   * whatever Intent-catalog lookup a `normalize` implementation may consult internally) -- so an unknown
   * canonical or an invalid/unknown param can otherwise reach `finalizeIntent` unchecked, minting a fresh
   * intentHash for a request that can never resolve. Implementing this closes that gap: reject such a
   * request by throwing `IntentValidationError` (spec-core's `errors.ts`; `message` and every issue's
   * `message` must be safe to show a client, since REST/MCP surface them as-is). On success, returns the
   * normalized IntentInput (e.g. with schema defaults filled in) that the caller hashes and finalizes
   * instead of the one it was given.
   *
   * Optional and backward compatible: a `SemanticPort` that does not implement it keeps the historical
   * behavior of finalizing the caller-supplied Intent unchecked.
   */
  validateIntent?(intent: IntentInput, ctx: SessionContext): Promise<IntentInput>;
}
