import type {
  ActionParamIssue,
  ActionParamsSchema,
  ActionTier,
  ApprovalGrant,
  ApprovalPort,
  JsonObject,
  OperationDescriptor,
} from "@kohaku-ui/spec-core";
import { actionPayloadHash, findUnsafeActionParamKeys, validateActionParams } from "@kohaku-ui/spec-core";

/** The `ActionGateDenied.reason` of a host with no `ApprovalPort` at all (fixed text, safe to show a client). */
export const NO_APPROVAL_PORT_REASON = "no ApprovalPort is configured for this host";

export interface ActionGateOptions {
  /** Consulted for `"approve"`-tier actions. Omitted = an `"approve"`-tier action can never be allowed. */
  approvals?: ApprovalPort;
}

/** What `createActionGate().check` needs to decide one invoke attempt. */
export interface ActionGateRequest {
  /** The operation descriptor for the action being invoked (its `tier`/`confirmMessage` govern the gate). */
  descriptor: OperationDescriptor;
  /** The descriptor's pre-validated params schema (`OperationIndexEntry.paramsSchema`), if any. */
  paramsSchema?: ActionParamsSchema;
  payload: JsonObject;
  /** The request body's `confirmed` field (tier `"confirm"`). */
  confirmed?: boolean;
  /** The request body's `approval` field (tier `"approve"`). */
  approval?: string;
  /** The invoking principal's id -- bound into the approval verification as the requester. */
  requesterId: string;
  tenant?: string;
}

/** Allowed: params validated and the tier's gate (if any) is satisfied. Proceed to `DomainPort.invoke`. */
export interface ActionGateAllow {
  kind: "allow";
  tier: ActionTier;
  payloadHash: string;
  /** Present only when `tier === "approve"` (the grant that was successfully consumed). */
  grant?: ApprovalGrant;
}

/**
 * The payload carried a prototype-polluting key (`unsafeKey` issue, SPEC ACT-PRM-001) or failed
 * `validateActionParams` against the action's schema. Maps to 422 `ACTION_PARAMS_INVALID`.
 */
export interface ActionGateInvalid {
  kind: "invalid";
  issues: ActionParamIssue[];
}

/**
 * The tier's gate was not satisfied because nothing was presented yet: `"confirm"` without `confirmed:
 * true`, or `"approve"` without an `approval` token at all. Maps to 403 `APPROVAL_REQUIRED`.
 * `requestId` is freshly minted per check call (not persisted by the gate itself -- see
 * `ApprovalRequiredInfo`'s doc comment in spec-core's `rest-errors.ts`), for the caller to both surface
 * on the error envelope and stamp onto the paired `action.approvalRequested` audit record.
 */
export interface ActionGateApprovalRequired {
  kind: "approvalRequired";
  tier: "confirm" | "approve";
  payloadHash: string;
  requestId: string;
}

/**
 * Tier `"approve"` and either (a) no `ApprovalPort` is configured for this host at all — checked first,
 * unconditionally, whether or not a token was presented, since no token could ever verify and no
 * `POST /approvals` could ever mint one — or (b) a token *was* presented but did not
 * verify (wrong binding, expired, already used, self-approval). Distinguished from
 * `ActionGateApprovalRequired` so the caller can record a distinct audit event (`action.denied` vs
 * `action.approvalRequested`) even though both map to the same 403 `APPROVAL_REQUIRED` wire response.
 */
export interface ActionGateDenied {
  kind: "denied";
  tier: "approve";
  payloadHash: string;
  requestId: string;
  reason: string;
}

export type ActionGateResult =
  | ActionGateAllow
  | ActionGateInvalid
  | ActionGateApprovalRequired
  | ActionGateDenied;

/**
 * The governed-action gate (design.md #62/#63): validates a payload against its action's params schema,
 * then enforces the action's tier (`"auto"` / `"confirm"` / `"approve"`). One gate is shared by every
 * invoke of every action for a given host attach; it carries no per-action state itself (an
 * `ApprovalPort`, if configured, owns whatever state single-use enforcement needs).
 *
 * Order of checks (payload key safety, then params, then tier) is deliberate: a payload that is invalid on its own terms should
 * never demand a confirmation or an approval for it.
 */
export function createActionGate(options: ActionGateOptions = {}) {
  const { approvals } = options;

  return {
    async check(req: ActionGateRequest): Promise<ActionGateResult> {
      // Whole-payload unsafe-key scan first, independent of any schema: an action with no `paramsSchema`, an
      // undeclared property under `additionalProperties`, or an array with no `items` would otherwise let a
      // `__proto__` / `constructor` / `prototype` key through to `DomainPort.invoke`.
      const unsafeKeyIssues = findUnsafeActionParamKeys(req.payload);
      if (unsafeKeyIssues.length > 0) return { kind: "invalid", issues: unsafeKeyIssues };
      if (req.paramsSchema != null) {
        const issues = validateActionParams(req.paramsSchema, req.payload);
        if (issues.length > 0) return { kind: "invalid", issues };
      }

      const payloadHash = await actionPayloadHash(req.payload);
      const tier: ActionTier = req.descriptor.tier ?? "auto";

      if (tier === "auto") {
        return { kind: "allow", tier, payloadHash };
      }

      if (tier === "confirm") {
        if (req.confirmed === true) return { kind: "allow", tier, payloadHash };
        return { kind: "approvalRequired", tier, payloadHash, requestId: globalThis.crypto.randomUUID() };
      }

      // tier === "approve"
      if (approvals == null) {
        // Checked before whether a token was even presented: with no ApprovalPort at all, no token this
        // client could ever supply would verify, and POST /approvals can never mint one either — so this fails closed
        // unconditionally rather than teasing a retry via `approvalRequired`.
        return {
          kind: "denied",
          tier,
          payloadHash,
          requestId: globalThis.crypto.randomUUID(),
          reason: NO_APPROVAL_PORT_REASON,
        };
      }
      if (req.approval == null) {
        return { kind: "approvalRequired", tier, payloadHash, requestId: globalThis.crypto.randomUUID() };
      }
      const verdict = await approvals.verifyApproval(req.approval, {
        action: req.descriptor.name,
        payloadHash,
        requesterId: req.requesterId,
        tenant: req.tenant,
      });
      if (!verdict.ok) {
        return {
          kind: "denied",
          tier,
          payloadHash,
          requestId: globalThis.crypto.randomUUID(),
          reason: verdict.reason ?? "approval denied",
        };
      }
      return { kind: "allow", tier, payloadHash, grant: verdict.grant };
    },
  };
}

export type ActionGate = ReturnType<typeof createActionGate>;
