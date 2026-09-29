import { CanonicalNameSchema, JsonObjectSchema } from "@kohaku-ui/spec-core";
import { z } from "zod";

/**
 * Aggregation of the REST profile's request-body zod schemas.
 * Kept in one place because they are used across route groups (compose / binding / governance / promotions /
 * fixations) (ComposeBodySchema is shared by the 3 compose routes and /fixations/approve).
 */

const SemanticInputSchema = z.union([
  z.object({ kind: z.literal("nl"), text: z.string().min(1), locale: z.string().optional() }),
  z.object({
    kind: z.literal("gui"),
    action: z.string().min(1),
    params: JsonObjectSchema,
    current: z
      .object({
        canonical: CanonicalNameSchema,
        params: JsonObjectSchema,
        hash: z.string(),
      })
      .optional(),
  }),
]);

const SessionSchema = z
  .object({
    // Bounded so an oversized client-supplied surface tag cannot inflate lineage records / recorder keys
    // indefinitely (same rationale as sessionId below).
    surface: z.string().max(64).default("web"),
    // Bounded so an oversized client-supplied sessionId cannot inflate lineage records / recorder keys
    // indefinitely (params/payload get the same treatment below via JsonObjectSchema's depth cap).
    sessionId: z.string().max(128).optional(),
    // Optional locale tag ("en" / "ja"). Threaded to SessionContext.locale so hosts can vary
    // NL normalization hints and (product policy permitting) generation output language.
    locale: z.string().max(64).optional(),
  })
  .default({ surface: "web" });

export const ComposeBodySchema = z.object({
  input: SemanticInputSchema.optional(),
  intent: z.object({ canonical: CanonicalNameSchema, params: JsonObjectSchema }).optional(),
  session: SessionSchema.optional(),
});

export const EventsBodySchema = z.object({
  intent: z.object({ canonical: CanonicalNameSchema, params: JsonObjectSchema }),
  event: z.object({
    on: z.string().min(1),
    payload: JsonObjectSchema.default({}),
  }),
  session: SessionSchema.optional(),
});

export const ActionBodySchema = z.object({
  action: z.string().min(1),
  // A JSON object only (an array/string/etc. is rejected with 400): DomainPort.invoke's `args` contract is an
  // object of named params, and passing anything else through would misrepresent it as one.
  payload: JsonObjectSchema.optional(),
  // Governed actions (design.md #62/#63, SPEC ACT-CNF-001/ACT-APR-001): the same-request acknowledgement for
  // a `"confirm"`-tier action. Ignored by the gate for any other tier.
  confirmed: z.boolean().optional(),
  // The bound approval token for a `"approve"`-tier action (issued by `POST /approvals`). Bounded length: an
  // approval token is a fixed-shape HMAC token, never expected to approach this size -- the bound only guards
  // against an oversized garbage value being carried through to `ApprovalPort.verifyApproval`.
  approval: z.string().max(4096).optional(),
});

/**
 * `POST /approvals` (Draft; SPEC ACT-APR-001): an authorized approver mints a token bound to
 * `(action, payloadHash, requesterId, tenant)` for a pending `"approve"`-tier action. `requesterId` is
 * the requester's principal id, which an approver-facing flow takes from the actor of the requester's
 * `action.approvalRequested` lineage record (the 403 `APPROVAL_REQUIRED` descriptor carries no requester) --
 * this route has no notion of "the current pending request" of its own (design.md #63: approvals are
 * stateless and unbound to any persisted request).
 */
export const ApprovalRequestBodySchema = z.object({
  action: z.string().min(1),
  payloadHash: z.string().min(1).max(128),
  requesterId: z.string().min(1).max(256),
  ttlSeconds: z.number().int().positive().max(86400).optional(),
});

export const TelemetryBodySchema = z.object({
  // Per-batch cap. Clamp at 500 to prevent resource exhaustion of the recording process from an oversized batch.
  // Per-field string bounds (surface/renderer .max(64), specHash/artifactId .max(128)) mirror SessionSchema's
  // sessionId bound above: these client-supplied strings flow into lineage records / recorder keys, which
  // must not grow unboundedly from an oversized single field either.
  events: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("rendered"),
          specHash: z.string().max(128),
          surface: z.string().max(64).optional(),
          renderer: z.string().max(64).optional(),
          durationMs: z.number().optional(),
        }),
        z.object({
          kind: z.literal("componentUsed"),
          artifactId: z.string().max(128),
          surface: z.string().max(64).optional(),
          outcome: z.enum(["ok", "error"]).optional(),
          sessionId: z.string().optional(),
        }),
      ]),
    )
    .max(500),
});

/**
 * Input schema for the promotion ComponentDraft (a structural copy of lineage's ComponentDraft. The type is held on
 * the host-rest side to respect the dependency direction). Used by approve's body and the schema.propose action.
 */
export const ComponentDraftSchema = z.object({
  componentType: z.string().min(1),
  version: z.string().min(1),
  intentName: z.string().min(1),
  description: z.string().min(1),
  paramsJsonSchema: z.unknown().optional(),
  // Data wiring for the promotion Intent. When omitted, the product default (compatible with the old promoted.json).
  queryTemplate: z
    .object({
      path: z.string().min(1),
      fixedParams: z.record(z.string(), z.string()).optional(),
      paramMap: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
});

/**
 * A structural copy of ComponentDraft (independent of lineage). paramsJsonSchema is used by the queryTemplate wiring.
 * Defined separately from lineage's ComponentDraft due to the dependency direction (reverse dependency forbidden).
 * Drift between the two is checked at the type level by apps/sample-api/test/component-draft-contract.test.ts.
 */
export type ComponentDraftInput = z.infer<typeof ComponentDraftSchema>;

/**
 * Input schema for the generic action (POST /promotions/:id/actions).
 * reviewer / by (Principal) do not accept a client declaration; the server-side principal is injected via withPrincipal.
 */
export const PromotionActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nominate") }),
  z.object({ kind: z.literal("judge.start") }),
  z.object({
    kind: z.literal("judge.result"),
    verdict: z.object({ pass: z.boolean(), score: z.number() }),
  }),
  z.object({ kind: z.literal("review.start") }),
  z.object({ kind: z.literal("review.approve"), comment: z.string().optional() }),
  z.object({ kind: z.literal("review.requestChanges"), comment: z.string().optional() }),
  z.object({ kind: z.literal("review.reject"), comment: z.string().optional() }),
  z.object({ kind: z.literal("schema.propose"), draft: ComponentDraftSchema }),
  z.object({ kind: z.literal("publish"), version: z.string().min(1) }),
  z.object({ kind: z.literal("withdraw"), reason: z.string().optional() }),
  z.object({ kind: z.literal("unpublish"), reason: z.string().optional() }),
]);
