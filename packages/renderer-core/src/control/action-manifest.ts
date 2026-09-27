import {
  type ActionParamIssue,
  type ActionParamsSchema,
  type ActionTier,
  type JsonObject,
  type JsonValue,
  validateActionParams,
} from "@kohaku-ui/spec-core";
import type { ActionPhase } from "./invoke.js";

/**
 * One entry of the Governed Actions manifest (design.md #62/#64, SPEC §6.1/§6.1.1 [Draft]): the wire
 * shape of `actions[name]` on a compose response. Structurally mirrors host-core's `ActionManifestEntry`
 * (packages/host-core/src/action-manifest.ts) -- duplicated here rather than imported, since
 * renderer-core does not depend on `@kohaku-ui/host-core` (AGENTS.md's dependency direction places
 * renderer-core upstream of host-core), the same reason `@kohaku-ui/client`'s types.ts already carries
 * its own copy.
 */
export interface ActionManifestEntry {
  tier: ActionTier;
  /**
   * The action's raw params schema (the same value `OperationDescriptor.paramsSchema` declared), when
   * present. Kept as the wire-shaped `JsonValue` (not the stricter `ActionParamsSchema`) since it arrives
   * over the wire from the host -- `preflightAction` casts it before validating, the same trust boundary
   * already extended to the capability token itself.
   */
  paramsSchema?: JsonValue;
  confirmMessage?: string;
}

/**
 * `{ [actionName]: ActionManifestEntry }`. See host-core's `ActionManifest` for the full doc -- carried
 * alongside a compose response, outside the Spec itself, so it never affects `specHash` / the cache key.
 */
export type ActionManifest = Record<string, ActionManifestEntry>;

/**
 * The outcome of a client-side governed-action pre-check (design.md #62/#63), run against the
 * compose-issued `ActionManifest` before ever calling `BindingClient.invokeAction`. Purely a UX shortcut
 * to avoid a round trip for an already-known-bad invoke -- the host remains authoritative, and
 * `runInvokeTarget` maps the identical outcomes from the server's own response (`BindingError`'s
 * `ACTION_PARAMS_INVALID` / `APPROVAL_REQUIRED` codes) when no manifest entry is available to check
 * locally, or when the manifest is stale relative to the server's own state.
 * - "allow": the action is absent from the manifest (unknown to this check -- the invoke proceeds
 *   ungated, matching the host's own "absent from the operation index" behavior), or its tier is "auto"
 *   and (if declared) the payload validated against `paramsSchema`.
 * - "invalid": the payload failed `paramsSchema` validation.
 * - "confirm": the action's tier is "confirm" and needs a same-request `confirmed: true`.
 * - "approve": the action's tier is "approve" and needs a bound approval token.
 */
export type PreflightActionResult =
  | { kind: "allow" }
  | { kind: "invalid"; issues: ActionParamIssue[] }
  | { kind: "confirm"; confirmMessage?: string }
  | { kind: "approve" };

/**
 * Client-side pre-check of one action invoke against the compose-issued Action manifest (design.md
 * #62/#63). Params-schema validation happens before the tier check (mirrors host-core's `ActionGate`
 * order): a payload invalid on its own terms should never demand a confirmation or an approval for it.
 * `manifest` absent, or `action` absent from it, is treated as "allow" (no local check possible; the
 * server remains the actual authority for this invoke).
 */
export function preflightAction(
  manifest: ActionManifest | undefined,
  action: string,
  payload: JsonObject,
): PreflightActionResult {
  const entry = manifest?.[action];
  if (entry == null) return { kind: "allow" };
  if (entry.paramsSchema != null) {
    const issues = validateActionParams(entry.paramsSchema as unknown as ActionParamsSchema, payload);
    if (issues.length > 0) return { kind: "invalid", issues };
  }
  if (entry.tier === "confirm") return { kind: "confirm", confirmMessage: entry.confirmMessage };
  if (entry.tier === "approve") return { kind: "approve" };
  return { kind: "allow" };
}

/**
 * Summarizes a governed action's invoke outcome for a model-visible report (e.g. MCP's
 * `ui/update-model-context`, `@kohaku-ui/mcp-renderer`'s boot), **never including the payload's actual
 * field values** -- only the action name, its tier/gate state, and (for a failed validation) the *shape*
 * of what went wrong (`ActionParamIssue`'s `path` / `code` / `message`, which describe the schema
 * violation, never the submitted value itself). Mirrors the reference-passing principle already upheld
 * for bulk read data: the model is told *that* an action needs confirmation or was rejected, never *what
 * was in it*.
 */
export function summarizeActionForModel(action: string, phase: ActionPhase): string {
  switch (phase.phase) {
    case "idle":
      return `${action}: not yet attempted`;
    case "pending":
      return `${action}: in progress`;
    case "succeeded":
      return `${action}: completed`;
    case "invalid":
      return `${action}: rejected (${
        phase.issues.map((i) => `${i.path || "(payload)"}: ${i.code}`).join(", ") || "invalid payload"
      })`;
    case "awaitingApproval":
      return phase.tier === "confirm"
        ? `${action}: requires user confirmation before it can run`
        : `${action}: requires approval before it can run`;
    case "failed":
      return `${action}: failed (${phase.message})`;
  }
}
