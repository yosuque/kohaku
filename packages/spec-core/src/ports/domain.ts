import type { ActionTier } from "../action-params.js";
import type { JsonObject, JsonValue } from "../schema/json.js";
import type { DataShape } from "../tabular.js";

export interface Principal {
  id: string;
  name?: string;
  roles?: string[];
}

export type Surface = "web" | "chat" | "mcp-app" | (string & {});

export interface SessionContext {
  surface: Surface;
  sessionId?: string;
  principal?: Principal;
  locale?: string;
  /**
   * Tenant identifier (the multi-tenant contract). When specified, it propagates to lineage
   * recording, the aggregation scope of promotion/fixation, and the fixation short-circuit, so the
   * governance plane (lineage / promotion / fixation) is separated per tenant. If omitted, it is
   * equivalent to a single tenant (legacy behavior). **Not included in the cache key** (query://
   * references are tenant-neutral, and tenant filtering is done by DomainPort via
   * InvocationContext.principal / capability).
   */
  tenant?: string;
}

/** Exposure of the business API. Invariants remain behind this (in the domain module). */
export interface OperationDescriptor {
  name: string;
  description: string;
  /**
   * JSON Schema (doubles as the semantic-layer document in the LLM prompt). When this operation is
   * reachable as a write action (SPEC §5 A1), a value here is additionally validated at attach time
   * against kohaku's own JSON Schema subset (design.md #62; `schema/action-params.ts`'s
   * `ActionParamsSchemaSchema`, enforced by host-core's `createOperationIndex`) and, per invoke, against
   * the actual payload (`validateActionParams`) before `DomainPort.invoke` ever runs.
   */
  paramsSchema?: JsonValue;
  resultShape?: DataShape;
  /**
   * Governance tier for invoking this action (design.md #62/#63). Default `"auto"` when omitted (no
   * confirm/approval gate — the pre-existing, ungated invoke behavior).
   */
  tier?: ActionTier;
  /**
   * Human-readable message a `"confirm"`-tier gate should show the user before setting `confirmed:
   * true` (renderer-core's `preflightAction` / the default `globalThis.confirm` hook). Ignored for
   * other tiers.
   */
  confirmMessage?: string;
}

export interface InvocationContext {
  principal: Principal;
  capability?: string;
}

export interface DomainPort {
  listOperations(): Promise<OperationDescriptor[]>;
  invoke(op: string, args: JsonObject, ctx: InvocationContext): Promise<unknown>;
}
