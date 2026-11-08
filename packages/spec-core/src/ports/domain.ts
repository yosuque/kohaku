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
  /**
   * The tenant the invocation runs under. On the REST data plane this is the tenant bound into the verified
   * capability (SPEC CAP-TEN-002), falling back to the host's own tenant resolution for a tenant-less
   * (pre-upgrade) capability. Absent when no tenant applies.
   */
  tenant?: string;
}

export interface DomainPort {
  /**
   * Every operation this port can run, with its governance `tier`. Contract (SPEC ACT-RD-001, design.md #77): every
   * operation with side effects MUST be listed here with its tier, because the host guards both the action
   * path and the data-plane read path (`query://` refs) off this list, and an operation it does not list is
   * treated as a plain query.
   */
  listOperations(): Promise<OperationDescriptor[]>;
  /**
   * Runs `op`. Contract (SPEC ACT-RD-001): `invoke` MUST dispatch on the exact operation name it is given, with
   * no case folding, trailing-slash stripping, percent-decoding or other normalization, so the name a host
   * looked up in `listOperations()` is the operation that runs.
   */
  invoke(op: string, args: JsonObject, ctx: InvocationContext): Promise<unknown>;
}
