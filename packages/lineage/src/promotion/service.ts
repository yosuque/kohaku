import { GOVERNANCE_ERROR_DISCRIMINATORS, type Principal, type StoragePort } from "@kohaku-ui/spec-core";
import { GENERATED_SCAN_WINDOW, RECONCILE_AUDIT_SCAN_WINDOW } from "../constants.js";
import type { ActorKind, LineageEventType } from "../events.js";
import type { Lineage } from "../lineage.js";
import { type TenantScope, tenantField } from "../tenant-scope.js";
import { recordFailOpen } from "./audit.js";
import { createCandidateStore } from "./candidate-store.js";
import {
  type ComponentDraft,
  type JudgeVerdict,
  type MachinePolicy,
  mayHaveProjection,
  type PromotionAction,
  type PromotionStatus,
  transition,
} from "./machine.js";
import { createNomination } from "./nomination.js";
import { createUsageIndex, indexLatestGenerated, tallyUsage, usageIndexKey } from "./usage.js";

export interface PromotionPolicy extends MachinePolicy {
  /** Threshold for candidacy (usage log -> candidate) */
  minUses: number;
  minDistinctSessions: number;
}

/**
 * Base of the batch-transition "did not reach the goal" errors (approve -> published / reject -> rejected),
 * thrown instead of swallowing a silent no-op. Subclasses pin only the discriminators and the message:
 * host-rest maps these by the code / name discriminators (it must not import this package — dependency
 * direction), so those values are part of the wire-adjacent contract. Both sides share the literals via
 * spec-core's GOVERNANCE_ERROR_DISCRIMINATORS, so a rename is caught by the compiler.
 */
export abstract class PromotionChainError extends Error {
  readonly artifactId: string;
  readonly status: PromotionStatus;
  readonly verdict?: unknown;
  constructor(message: string, artifactId: string, status: PromotionStatus, verdict?: unknown) {
    super(message);
    this.artifactId = artifactId;
    this.status = status;
    this.verdict = verdict;
  }
}

/**
 * Indicates that approve()'s batch transition did not reach published (it stayed at an intermediate non-terminal
 * state due to a judge failure, review rejection, etc.), so the caller can detect "approved yet not published."
 */
export class PromotionNotPublishedError extends PromotionChainError {
  readonly code = GOVERNANCE_ERROR_DISCRIMINATORS.notPublishedCode;
  constructor(artifactId: string, status: PromotionStatus, verdict?: unknown) {
    super(
      `Promotion approval did not reach published (artifact ${artifactId} is in status "${status}")`,
      artifactId,
      status,
      verdict,
    );
    this.name = "PromotionNotPublishedError";
  }
}

/**
 * Indicates that reject()'s batch transition did not reach rejected (reject() was called from an intermediate /
 * terminal state such as judge_failed / changes_requested / approved and matched none of the transition steps,
 * so it could not reject; symmetric with PromotionNotPublishedError).
 */
export class PromotionNotRejectedError extends PromotionChainError {
  readonly code = GOVERNANCE_ERROR_DISCRIMINATORS.notRejectedCode;
  constructor(artifactId: string, status: PromotionStatus, verdict?: unknown) {
    super(
      `Promotion rejection did not reach rejected (artifact ${artifactId} is in status "${status}")`,
      artifactId,
      status,
      verdict,
    );
    this.name = GOVERNANCE_ERROR_DISCRIMINATORS.notRejectedName;
  }
}

export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = {
  minUses: 20,
  minDistinctSessions: 5,
  judgeBlocking: true,
};

/**
 * The call sites `createPromotions`' `onError` hook may fire from, named for the observability hook:
 * - `promotion.publish.audit` / `promotion.unpublish.audit`: the fail-open `component.published` /
 *   `component.withdrawn` audit record at publish/unpublish time failed (handlePublish / handleUnpublish).
 * - `promotion.reconcile.audit`: reconcile's audit-event backfill (for either side) failed.
 * - `promotion.reconcile.projection`: reconcile skipped re-applying a published snapshot's projection because
 *   neither the snapshot itself nor `component.generated` could supply the required html (#9).
 * - `promotion.nominate.tenant`: `evaluateAndList` (tenant unspecified) skipped auto-nominating a candidate that
 *   belongs to a specific tenant, to avoid persisting a tenant-neutral state for it (#10; promotion/nomination.ts).
 * - `promotion.nominate.audit`: the fail-open `component.nominated` audit record (recorded after the status
 *   transition to `candidate` is already persisted) failed for one nominated candidate (promotion/nomination.ts).
 *   Unlike publish/unpublish's audit, there is currently no reconcile-style backfill for a missed
 *   `component.nominated` event, so the audit trail stays incomplete for that artifact until a manual fix.
 * - `storage.record.invalid`: a promotion-state record read back from `StoragePort.getPromotionState`
 *   (candidate-store.ts's `loadCandidate`) failed `@kohaku-ui/spec-core`'s `PromotionStateSchema` (a
 *   corrupted or hand-edited `promotions.json` entry). The reader treats it exactly
 *   like a real absence (the candidate falls back to status "in_use", the same default as no persisted state
 *   at all); shared with lineage's Fixations service, which uses the same discriminator string for the
 *   equivalent fixation-record check (fixation/service.ts's `FixationErrorEndpoint`).
 */
export type PromotionErrorEndpoint =
  | "promotion.publish.audit"
  | "promotion.unpublish.audit"
  | "promotion.reconcile.audit"
  | "promotion.reconcile.projection"
  | "promotion.nominate.tenant"
  | "promotion.nominate.audit"
  | "storage.record.invalid";

/** Context passed to `createPromotions`' `onError` hook alongside the causing error. */
export interface PromotionErrorContext {
  endpoint: PromotionErrorEndpoint;
  artifactId: string;
  tenant?: string;
}

/**
 * Fires opts.onError fire-and-forget, swallowing any synchronous throw from the hook itself (an
 * observation-only hook must never mask or replace the caller's own error/result). Deliberately local
 * (not imported from composer's fireObserverHook) because lineage does not depend on composer (dependency
 * direction). Exported so promotion/nomination.ts (the tenant-mismatch skip, #10) can share the same
 * fire-and-forget discipline rather than duplicating it.
 */
export function notifyPromotionError(
  onError: ((ctx: PromotionErrorContext, error: unknown) => void) | undefined,
  ctx: PromotionErrorContext,
  error: unknown,
): void {
  if (onError == null) return;
  try {
    onError(ctx, error);
  } catch {
    // Swallowed: an observability-only hook must not affect publish/reconcile's own control flow.
  }
}

/**
 * Copies the action-carried data onto the candidate for the two action kinds that mutate persisted candidate
 * state beyond status (judge.result -> verdict, schema.propose -> draft). Every other action kind is a no-op
 * here (status alone, already advanced by `transition` before this runs, is what gets persisted). Extracted out
 * of act's switch so the "what data does this action carry" question is answered in one place,
 * independent of "what gets audited" (auditEventFor) and "how is publish/unpublish special" (handlePublish /
 * handleUnpublish, which do not call this — their data copying, if any, lives in their own bodies).
 */
function applyActionData(candidate: PromotionCandidate, action: PromotionAction): void {
  switch (action.kind) {
    case "judge.result":
      candidate.verdict = action.verdict;
      break;
    case "schema.propose":
      candidate.draft = action.draft;
      break;
    default:
      break;
  }
}

/**
 * Builds the lineage audit event `act` should record for a given action, or undefined when the action kind has
 * no audit event of its own (judge.start / review.start are pure state-transition markers with no persisted
 * record; publish / unpublish never reach here because `act` returns early via handlePublish / handleUnpublish
 * before this is called). Pure and side-effect-free: the caller (act) is the one that actually calls
 * lineage.record, passing the tenant scope through.
 */
function auditEventFor(
  action: PromotionAction,
  artifactId: string,
  actor: Principal,
): { type: LineageEventType; payload: Record<string, unknown>; actor?: ActorKind } | undefined {
  switch (action.kind) {
    case "nominate":
      return { type: "component.nominated", payload: { artifactId, by: actor.id } };
    case "judge.start":
      return undefined;
    case "judge.result":
      return { type: "component.judged", payload: { artifactId, verdict: action.verdict } };
    case "review.start":
      return undefined;
    case "review.approve":
    case "review.requestChanges":
    case "review.reject":
      return {
        type: "component.reviewed",
        payload: {
          artifactId,
          decision: action.kind.replace("review.", ""),
          reviewer: actor.id,
          ...(action.comment != null ? { comment: action.comment } : {}),
        },
        actor: { kind: "user", id: actor.id },
      };
    case "schema.propose":
      return {
        type: "component.schemaProposed",
        payload: { artifactId, draft: action.draft as unknown as Record<string, unknown> },
      };
    case "withdraw":
      return {
        type: "component.withdrawn",
        payload: { artifactId, ...(action.reason != null ? { reason: action.reason } : {}) },
      };
    case "publish":
    case "unpublish":
      return undefined;
  }
}

export interface PromotionCandidate {
  artifactId: string;
  status: PromotionStatus;
  canonical?: string;
  request?: string;
  html?: string;
  /** The artifact body's sha256 (used for content verification at sandbox mount time). */
  sha256?: string;
  /** The data reference at generation time (data.$ref). Used to re-mount the preview and resolve its data. */
  ref?: string;
  uses: number;
  sessions: number;
  verdict?: unknown;
  draft?: ComponentDraft;
  updatedAt: string;
}

/**
 * Builds the onPublish projection argument object (draft/html required, request/tenant included only when
 * non-null). Shared by `handlePublish` (the publish transition) and `reconcile` (projection recovery from
 * snapshot authority) so the two call sites cannot drift. Callers must only invoke this once candidate.draft
 * and candidate.html are confirmed non-null (handlePublish's guard above; reconcile's `continue` guard).
 * Pure (no closure dependency on createPromotions' opts/store, moved to module scope for direct
 * unit testing).
 */
export function publishArgs(
  candidate: PromotionCandidate,
  tenant?: string,
): { artifactId: string; draft: ComponentDraft; html: string; request?: string; tenant?: string } {
  return {
    artifactId: candidate.artifactId,
    draft: candidate.draft!,
    html: candidate.html!,
    ...(candidate.request != null ? { request: candidate.request } : {}),
    ...tenantField(tenant),
  };
}

/**
 * Promotion-review hook on the approve path (LLM-as-Judge, etc.). Receives a candidate and returns pass/fail and
 * a score. The 2nd argument context.tenant is additive optional: it propagates the tenant passed to approve
 * into the judge, enabling per-tenant aggregation of telemetry etc. (existing implementations that ignore context
 * remain compatible). When multiple tenants use the same artifactId (globally unique since it derives from the
 * content sha256), this lets the judge narrow its aggregation scope so its evidence does not get mixed across
 * tenants. rubricId / rubricVersion are additive optional: if returned, they are transcribed into the
 * component.judged verdict so which rubric version judged remains in the audit. reason explains a
 * cannot-decide / supplementary note.
 */
export type PromotionJudge = (candidate: PromotionCandidate, context?: TenantScope) => Promise<JudgeVerdict>;

/** Options for Promotions.withdraw: reason is the optional human-facing note, scope narrows the owning tenant. */
export interface WithdrawOptions extends TenantScope {
  reason?: string;
}

export interface Promotions {
  /**
   * Side-effect-free candidate list (read-only, does not auto-nominate). Used for GET-style reads.
   * When you want to make a threshold-satisfying in_use into a candidate, use evaluateAndList.
   * Passing scope.tenant aggregates only that tenant's component.generated / used / nominated
   * (unset = all = legacy behavior).
   */
  list(scope?: TenantScope): Promise<PromotionCandidate[]>;
  /**
   * Per-status list (the changes_requested-to-candidate recovery path's read side). Uses listPromotionStates (snapshot projection) as the index and directly pulls the
   * set of artifacts in that status (no full component.generated scan like list does). No side effects.
   * Only status === "in_use" has no persisted state (before nominate), so it is delegated to the same event scan as list.
   * scope.tenant narrows the aggregation.
   */
  listByStatus(status: PromotionStatus, scope?: TenantScope): Promise<PromotionCandidate[]>;
  /** Scans the usage log to make threshold-satisfying artifacts into candidates (has side effects) and returns the list. scope.tenant narrows the aggregation. */
  evaluateAndList(scope?: TenantScope): Promise<PromotionCandidate[]>;
  /** Single fetch. When scope.tenant is given, returns only candidates whose owning tenant matches (non-match is null = does not exist for other tenants). */
  get(artifactId: string, scope?: TenantScope): Promise<PromotionCandidate | null>;
  act(
    artifactId: string,
    action: PromotionAction,
    actor: Principal,
    scope?: TenantScope,
  ): Promise<PromotionCandidate>;
  /**
   * "Approve and register": batch-executes the fixed transitions nominate -> judge -> review.approve ->
   * schema.propose -> publish. The transition order is confined inside this, so the caller (HTTP, etc.) only
   * expresses intent. When scope.tenant is given, it verifies the owning tenant and stamps each intermediate
   * transition's lineage record with it too.
   */
  approve(
    artifactId: string,
    draft: ComponentDraft,
    reviewer: Principal,
    scope?: TenantScope,
  ): Promise<PromotionCandidate>;
  /** "Reject": batch-executes the fixed transitions nominate -> review.start -> review.reject. When scope.tenant is given, it verifies the owning tenant. */
  reject(artifactId: string, reviewer: Principal, scope?: TenantScope): Promise<PromotionCandidate>;
  /**
   * "Withdraw": if published, unpublish (published->withdrawn, fires onUnpublish); otherwise, for any other
   * non-terminal, the withdraw fixed transition. If already terminal (rejected/withdrawn), the machine throws
   * TransitionError (propagated as-is). When options.tenant is given, it verifies the owning tenant.
   */
  withdraw(artifactId: string, actor: Principal, options?: WithdrawOptions): Promise<PromotionCandidate>;
  /**
   * Projection recovery from snapshot authority. Scans the published-status snapshots (the state authority)
   * across all tenants and re-runs each artifact's onPublish (idempotent projection application), re-deriving the
   * catalog projection from the snapshot. Even if publish's side-effect application fails partway and splits into
   * "the snapshot is published but the catalog is not reflected," calling this at startup converges the projection
   * (makes the snapshot the sole state authority). If onPublish is not idempotent it would be applied twice, so
   * onPublish must be an idempotent implementation (a contract).
   *
   * Symmetrically, also scans every non-published snapshot and re-runs onUnpublish (idempotent projection
   * removal) for any whose candidate still has a persisted draft — converging a withdrawal whose projection
   * removal failed partway (the snapshot transitioned to withdrawn, but the catalog/Intent entry was never
   * removed). onUnpublish must likewise be idempotent.
   *
   * Callable at any time (not just at startup) — e.g. host-rest's `POST /promotions/reconcile` (an operator
   * escape hatch to force convergence on demand, #11) — so it must remain safe to run concurrently with other
   * promotion transitions (the REST route serializes it under the same per-tenant-neutral lock bucket as
   * approve/reject/withdraw/actions). Returns a summary of what it did; existing callers that ignore the return
   * value (e.g. startup reconcile) are unaffected.
   */
  reconcile(): Promise<ReconcileSummary>;
}

/** Summary returned by `reconcile()` (#11): how many published/withdrawn snapshots had their projection
 * re-applied, and how many were skipped because the data needed to rebuild the projection was unrecoverable
 * (reported individually via `onError({endpoint: "promotion.reconcile.projection"})`). */
export interface ReconcileSummary {
  published: number;
  withdrawn: number;
  skipped: number;
}

/**
 * Application service for the promotion pipeline (L2->L1).
 * State is dual-recorded in the StoragePort (snapshot) + Lineage events, but the "source of truth" of the two is
 * split by role:
 * - **The read source of truth is the snapshot** (getPromotionState / listPromotionStates). Both state
 *   transitions (load->transition->persist) and the per-status list (listByStatus) use the snapshot as the index.
 * - **Lineage is the audit source of truth** (an append-only log of who / when / which version judged/approved).
 * A path to recover state by reconstructing (replaying) from Lineage events when the snapshot is lost is
 * **not implemented** (a known constraint, out of scope). Therefore the snapshot's persistence (promotions.json)
 * is the ultimate state authority. publish's side effects (reflecting into the Registry / Intent catalog) are
 * implemented by the product via onPublish.
 */
export function createPromotions(opts: {
  lineage: Lineage;
  storage: StoragePort;
  policy?: Partial<PromotionPolicy>;
  /**
   * Projection application at publish time (product responsibility): catalog registration, Intent addition,
   * persistence. **Must be idempotent**: applied in the order snapshot authority -> projection, and because
   * reconcile re-runs it at startup, an already-reflected (tenant, artifactId) must be a no-op. Do not throw here
   * (collision checks belong in validatePublish). tenant is the projection's owning tenant (the value passed
   * to the approve/act that called publish).
   */
  onPublish?: (args: {
    artifactId: string;
    draft: ComponentDraft;
    html: string;
    request?: string;
    tenant?: string;
  }) => Promise<void>;
  /**
   * Pre-check for publish (product responsibility, optional): checks catalog/Intent name collisions etc. and
   * throws if publishing is not allowed. A check gate called **before the state transition (persist)**: if it
   * throws here, the snapshot does not transition to published and never reaches the projection (onPublish). It
   * must carry no side effects (a pure check). tenant narrows the check.
   */
  validatePublish?: (args: {
    artifactId: string;
    draft: ComponentDraft;
    html: string;
    tenant?: string;
  }) => Promise<void>;
  /**
   * Side effect at unpublish (withdrawal from published) time (product responsibility): removal from the
   * catalog/Intent. Symmetric with onPublish, and **must be idempotent** for the same reason: it runs after the
   * snapshot has already transitioned to withdrawn (snapshot authority -> audit -> projection removal, mirroring
   * onPublish's order), and `reconcile` re-runs it at startup for every non-published snapshot whose candidate
   * still has a persisted draft, so an already-removed (tenant, artifactId) projection must be a no-op.
   * tenant is the removal target's owning tenant.
   */
  onUnpublish?: (args: { artifactId: string; draft: ComponentDraft; tenant?: string }) => Promise<void>;
  /** Promotion review called from the candidate state on the approve path. If unset, the review is skipped (straight to human review with no advice). */
  judge?: PromotionJudge;
  /**
   * Fail-open observability hook (product responsibility, optional): notified on every failure/skip listed on
   * `PromotionErrorEndpoint`'s doc (publish/unpublish audit fail-open, reconcile's audit backfill and projection
   * skip, and evaluateAndList's tenant-mismatch skip). Fired fire-and-forget (a throw / rejection from the hook
   * itself is swallowed and never propagates) — see `notifyPromotionError` below.
   */
  onError?: (ctx: PromotionErrorContext, error: unknown) => void;
}): Promotions {
  const policy: PromotionPolicy = { ...DEFAULT_PROMOTION_POLICY, ...opts.policy };
  const usage = createUsageIndex(opts.storage);
  const store = createCandidateStore({ storage: opts.storage, usage, onError: opts.onError });
  const { nominateEligible } = createNomination({
    storage: opts.storage,
    lineage: opts.lineage,
    policy,
    persistMany: store.persistMany,
    onError: opts.onError,
  });

  /** Read-only candidate list (does neither auto-nominate nor persist). */
  async function list(scope?: TenantScope): Promise<PromotionCandidate[]> {
    return store.scan(scope?.tenant);
  }

  /** Makes threshold-satisfying in_use into candidates (recording nominate) while returning the list. */
  async function evaluateAndList(scope?: TenantScope): Promise<PromotionCandidate[]> {
    return nominateEligible(await store.scanWithTenant(scope?.tenant), scope?.tenant);
  }

  /**
   * Per-status list (the changes_requested-to-candidate recovery path's read side). No side effects. Delegated verbatim to the candidate store
   * (promotion/candidate-store.ts): see its own doc for the in_use vs. snapshot-index distinction.
   */
  const listByStatus = store.listByStatus;

  /**
   * The core of the publish transition. Order: check gate -> snapshot authority -> audit -> projection.
   * Since it has already persisted here, it does not return to the caller (act's common persist at the end of the switch).
   * Takes artifactId from candidate.artifactId rather than a separate parameter: the sole caller (act) always
   * builds candidate via store.require(artifactId, tenant) immediately beforehand, and store.load always
   * sets the returned candidate's artifactId to that same argument, so candidate.artifactId === act's artifactId
   * always holds.
   */
  async function handlePublish(
    candidate: PromotionCandidate,
    action: Extract<PromotionAction, { kind: "publish" }>,
    tenant?: string,
  ): Promise<PromotionCandidate> {
    const artifactId = candidate.artifactId;
    if (candidate.draft == null) throw new Error("publish requires a schema draft");
    if (candidate.html == null) throw new Error("publish requires the artifact html");
    // Atomicity: process in the order "check gate -> snapshot authority -> audit -> projection application."
    // 1. validatePublish (pure check gate): if it throws on a collision etc., abort here and the snapshot does not
    //    transition to published (the persist below is not reached) = the pre-transition state is preserved.
    await opts.validatePublish?.({
      artifactId,
      draft: candidate.draft,
      html: candidate.html,
      ...tenantField(tenant),
    });
    // 2. Persist the snapshot (state authority) as published first. Even if something fails afterward,
    //    "snapshot = published" remains and startup reconcile can re-apply the projection to converge.
    await store.persist(candidate, tenant);
    // 3. Audit event (component.published). This is fail-open: a failure here (storage hiccup, etc.) must not
    //    block the projection below (the whole point of publishing), so it is reported via onError rather than
    //    thrown. The snapshot is already published (step 2), so `reconcile`'s audit backfill (below) later
    //    detects the missing component.published event and re-records it (with reconciled:true).
    await recordFailOpen(
      opts.lineage,
      opts.onError,
      "promotion.publish.audit",
      "component.published",
      {
        artifactId,
        componentType: candidate.draft.componentType,
        version: action.version,
        intentName: candidate.draft.intentName,
      },
      undefined,
      { tenant, artifactId },
    );
    // 4. Projection application (idempotent). A failure is a "not-reflected" against the snapshot authority, and reconcile converges it.
    await opts.onPublish?.(publishArgs(candidate, tenant));
    // publish already persisted above (do not run the common persist at the end twice).
    return candidate;
  }

  /**
   * The core of the unpublish transition. Order: snapshot authority -> audit -> projection removal, mirroring
   * handlePublish (snapshot-first, so a mid-sequence failure never leaves the snapshot in an inconsistent state
   * that a later reconcile could silently re-publish from). onUnpublish must be idempotent because reconcile
   * re-runs it for every non-published snapshot whose candidate still has a persisted draft.
   * Takes artifactId from candidate.artifactId for the same reason as handlePublish: the sole
   * caller (act) always builds candidate for this same artifactId immediately beforehand.
   */
  async function handleUnpublish(
    candidate: PromotionCandidate,
    action: Extract<PromotionAction, { kind: "unpublish" }>,
    actor: Principal,
    tenant?: string,
  ): Promise<PromotionCandidate> {
    const artifactId = candidate.artifactId;
    // transition succeeded = the original state is confirmed to be published (the machine rejects anything but published).
    // draft should have been schema.propose -> persisted at publish time. A published record without a draft is a
    // state inconsistency, so fail-fast (onUnpublish requires draft for catalog removal).
    if (candidate.draft == null) {
      throw new Error(`unpublish requires the persisted schema draft (artifact ${artifactId})`);
    }
    // 1. Persist the snapshot (state authority) as withdrawn first. Even if the audit record or the projection
    //    removal below fails, "snapshot = withdrawn" remains and startup reconcile can re-apply the projection
    //    removal to converge (it never re-publishes from a stale "published" snapshot).
    await store.persist(candidate, tenant);
    // 2. Audit event (component.withdrawn). from:"published" distinguishes this, for audit purposes, from a
    //    pre-promotion withdraw (a withdrawal from candidate etc.). Fail-open (#11), symmetric with handlePublish's
    //    own audit record: a storage hiccup here must not block the projection removal below (the whole point of
    //    unpublishing). The snapshot is already withdrawn (step 1), so `reconcile`'s audit backfill later detects
    //    the missing component.withdrawn (from:"published") event and re-records it (with reconciled:true).
    await recordFailOpen(
      opts.lineage,
      opts.onError,
      "promotion.unpublish.audit",
      "component.withdrawn",
      {
        artifactId,
        from: "published",
        by: actor.id,
        ...(action.reason != null ? { reason: action.reason } : {}),
      },
      { kind: "user", id: actor.id },
      { tenant, artifactId },
    );
    // 3. Projection removal (idempotent; reconcile re-runs it against any lingering projection).
    await opts.onUnpublish?.({
      artifactId,
      draft: candidate.draft,
      ...tenantField(tenant),
    });
    return candidate;
  }

  /**
   * Executes a single transition (load -> transition -> record -> persist).
   *
   * Idempotency contract: **act is not idempotent**. There is no optimistic lock on the candidate's
   * read-modify-write, and there is no serialization here like the component.nominated duplicate guard of
   * auto-nominate (scanCandidates). Thus serializing concurrent / retried calls to the same artifact is the
   * **caller's responsibility** (at the HTTP layer, guard with per-artifact serialization or optimistic locking, etc.).
   *
   * scope.tenant: when given, if the candidate's owning tenant (the component.generated tenant via
   * store.load) does not match, it is treated as "does not exist" (throws unknown artifact). The recorded
   * lineage is also stamped with the same tenant. Unset (single tenant) is the legacy behavior.
   */
  async function act(
    artifactId: string,
    action: PromotionAction,
    actor: Principal,
    scope?: TenantScope,
  ): Promise<PromotionCandidate> {
    const tenant = scope?.tenant;
    const candidate = await store.require(artifactId, tenant);

    // Invalid transitions from a terminal state are rejected by the machine side (transition) with a TransitionError.
    candidate.status = transition(candidate.status, action, policy);

    // publish / unpublish have persist-ordering (and, for unpublish, side-effect) requirements that differ from
    // every other action kind (see handlePublish / handleUnpublish's own docs), so they are kept as explicit
    // special cases that persist internally and return directly, bypassing applyActionData/auditEventFor/persist
    // below entirely.
    if (action.kind === "publish") return handlePublish(candidate, action, tenant);
    if (action.kind === "unpublish") return handleUnpublish(candidate, action, actor, tenant);

    // Every other action kind shares the same order: copy any action-carried data onto the candidate, record the
    // audit event (if the action kind has one), then persist once at the end.
    applyActionData(candidate, action);
    const event = auditEventFor(action, artifactId, actor);
    if (event != null) {
      await opts.lineage.record(event.type, event.payload, event.actor, tenant);
    }

    await store.persist(candidate, tenant);
    return candidate;
  }

  /**
   * Resolves the judge verdict for approve()'s judge stage. If no judge hook is
   * configured (opts.judge unset), treats it as a pass with no advice -> straight to human review. If the hook
   * throws, this does not fail-open: it falls to "cannot decide = fail," keeping the failure reason in the audit
   * trail via the verdict's `reason` (a stable message string, so component.judged payloads stay byte-identical
   * across callers). Whether that fail translates
   * into a hard stop (judge_failed) or an advisory pass-through is decided later, exclusively by the machine's
   * judgeBlocking policy at the judge.result transition — this function only resolves the verdict value.
   */
  async function runJudge(candidate: PromotionCandidate, tenant?: string): Promise<JudgeVerdict> {
    // judge unset (no review hook) is treated as a pass with no advice -> straight to human review.
    // rubricId / rubricVersion are transcribed into the component.judged verdict if the judge returns them (additive; older judges that omit them are unaffected).
    if (opts.judge == null) return { pass: true, score: 0 };
    try {
      // Propagate the tenant passed to approve into the judge. With this the judge can narrow its
      // aggregation of telemetry etc. to that tenant (other tenants' observations do not contaminate the verdict input).
      return await opts.judge(candidate, tenantField(tenant));
    } catch (e) {
      // A judge that cannot run (LLM trouble, etc.) does not fail-open but falls to "cannot decide = fail."
      // Whether promotion is allowed is delegated to the machine's judgeBlocking policy: with judgeBlocking:true
      // (default) it stops at judge_failed and this function's end guard throws PromotionNotPublishedError.
      // With judgeBlocking:false it proceeds to in_review as advisory. Include the reason in the verdict to keep it in the audit.
      return {
        pass: false,
        score: 0,
        reason: `judge could not run: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Batch-executes the fixed transitions from candidate (or in_use / changes_requested / judge_failed) to published.
   * Each if only advances one step from the current state, so if it is already terminal it returns that state as-is (idempotent-ish).
   * The state machine's transition order is confined to this function and not leaked to callers such as HTTP handlers.
   *
   * Recovery from changes_requested / judge_failed: a candidate sent back by review.requestChanges, or one that
   * stopped at judge_failed (a blocking judge failure), is also returned to candidate using the machine's
   * changes_requested / judge_failed --nominate--> candidate and rejoins the subsequent judge -> review -> approve
   * chain (= the "fix and re-approve" flow — a fresh judge run gives it another chance to pass). The transition
   * table is unchanged and the path from candidate onward is identical to the first approve, so LIN-PRM-001 (a
   * human review.approve precedes publish) is preserved.
   *
   * Idempotent re-projection on an already-published candidate (#11): approve() is not itself idempotent end to
   * end (each call re-runs judge/review), but a retry against a candidate that is *already* published (loaded as
   * such, before any of the transitions below run) previously returned success without re-running onPublish. If
   * the original publish's projection application (onPublish) had failed partway (see handlePublish's ordering
   * doc: the snapshot is persisted and audited before onPublish runs), the caller would see a successful retry
   * response yet the projection stayed un-reflected until the next reconcile. Re-running onPublish here instead
   * converges it immediately; this is safe because onPublish must already be idempotent (the same contract
   * `reconcile` relies on).
   */
  async function approve(
    artifactId: string,
    draft: ComponentDraft,
    reviewer: Principal,
    scope?: TenantScope,
  ): Promise<PromotionCandidate> {
    const tenant = scope?.tenant;
    let candidate = await store.require(artifactId, tenant);
    if (candidate.status === "published") {
      await opts.onPublish?.(publishArgs(candidate, tenant));
      return candidate;
    }
    // in_use (not yet nominated), changes_requested (sent back for changes), and judge_failed (a blocking judge
    // failure) all go (back) to candidate via nominate. This entry if is evaluated only once at the top of the
    // function, so even if it becomes changes_requested partway through the chain it is not re-entered (no loop).
    // A candidate that stays at judge_failed after this retry becomes a PromotionNotPublishedError at the end
    // guard (no swallowing of a cannot-decide).
    if (
      candidate.status === "in_use" ||
      candidate.status === "changes_requested" ||
      candidate.status === "judge_failed"
    ) {
      candidate = await act(artifactId, { kind: "nominate", by: reviewer }, reviewer, scope);
    }
    if (candidate.status === "candidate") {
      candidate = await act(artifactId, { kind: "judge.start" }, reviewer, scope);
      const verdict = await runJudge(candidate, tenant);
      candidate = await act(artifactId, { kind: "judge.result", verdict }, reviewer, scope);
    }
    if (candidate.status === "in_review") {
      candidate = await act(
        artifactId,
        { kind: "review.approve", reviewer, comment: "approved via promotions.approve" },
        reviewer,
        scope,
      );
    }
    if (candidate.status === "approved") {
      candidate = await act(artifactId, { kind: "schema.propose", draft }, reviewer, scope);
    }
    if (candidate.status === "schema_proposed") {
      candidate = await act(artifactId, { kind: "publish", version: draft.version }, reviewer, scope);
    }
    // If the batch transition did not advance to published (e.g. it stayed at judge_failed due to a judge
    // failure), throw the "approved yet not published" inconsistency rather than swallowing it. A re-approve of an
    // already-published entry enters none of the ifs and status stays "published," so here it returns idempotently without throwing.
    if (candidate.status !== "published") {
      throw new PromotionNotPublishedError(artifactId, candidate.status, candidate.verdict);
    }
    return candidate;
  }

  /** Batch-executes the fixed transitions from candidate (or in_use) to rejected. */
  async function reject(
    artifactId: string,
    reviewer: Principal,
    scope?: TenantScope,
  ): Promise<PromotionCandidate> {
    const tenant = scope?.tenant;
    let candidate = await store.require(artifactId, tenant);
    if (candidate.status === "in_use") {
      candidate = await act(artifactId, { kind: "nominate", by: reviewer }, reviewer, scope);
    }
    if (candidate.status === "candidate") {
      candidate = await act(artifactId, { kind: "review.start" }, reviewer, scope);
    }
    if (candidate.status === "in_review") {
      candidate = await act(artifactId, { kind: "review.reject", reviewer }, reviewer, scope);
    }
    // If the batch transition did not advance to rejected (called from a state matching none of the if steps, such
    // as judge_failed / changes_requested / approved / schema_proposed / published / withdrawn), throw rather than
    // swallowing, same as approve(). A re-reject of an already-rejected entry enters none of the ifs and status
    // stays "rejected," so here it returns idempotently without throwing (symmetric with approve's already-published).
    if (candidate.status !== "rejected") {
      throw new PromotionNotRejectedError(artifactId, candidate.status, candidate.verdict);
    }
    return candidate;
  }

  /**
   * Withdrawal. Routes published to unpublish (published->withdrawn + onUnpublish) and any other non-terminal to
   * the withdraw fixed transition. A withdraw against a terminal (rejected/withdrawn) makes the machine throw
   * TransitionError, which is propagated as-is (no swallowing of a re-withdrawal).
   */
  async function withdraw(
    artifactId: string,
    actor: Principal,
    options?: WithdrawOptions,
  ): Promise<PromotionCandidate> {
    const { reason, tenant } = options ?? {};
    const candidate = await store.require(artifactId, tenant);
    const action: PromotionAction =
      candidate.status === "published"
        ? { kind: "unpublish", ...(reason != null ? { reason } : {}) }
        : { kind: "withdraw", ...(reason != null ? { reason } : {}) };
    return act(artifactId, action, actor, options);
  }

  /** Single fetch. When scope.tenant is given, only candidates whose owning tenant matches (non-match is null = does not exist for other tenants). */
  async function get(artifactId: string, scope?: TenantScope): Promise<PromotionCandidate | null> {
    return store.load(artifactId, { tenant: scope?.tenant });
  }

  /**
   * Projection recovery from snapshot authority. Scans the published/withdrawn snapshots across all tenants —
   * every other status has no projection to converge, see `mayHaveProjection` — assembles each artifact's
   * complete candidate — since #9, `candidate.html` (and sha256/ref) come from the snapshot's own duplicated
   * copy when present, falling back to `component.generated` for older snapshots persisted before this change —
   * and idempotently re-applies onPublish. Called at startup (and callable on demand, e.g. host-rest's `POST
   * /promotions/reconcile`, #11), projections (catalog/Intent) left un-reflected by a mid-publish failure
   * converge from the snapshot. Symmetrically, re-applies onUnpublish for every withdrawn snapshot whose
   * candidate still has a persisted draft, converging a withdrawal whose projection removal failed partway.
   *
   * Race with a concurrent transition: the scan (`listPromotionStates`) and each candidate's `store.load` are
   * two separate reads with no lock held across them (host-rest's `POST /promotions/reconcile` route only takes
   * the tenant-neutral lock bucket, so a tenant-scoped approve/withdraw can run between the two). `store.load`
   * always re-reads `getPromotionState`, so right after it returns, the candidate's status is already the
   * freshest value on hand — trusting it is all the fix takes. Both branches below re-check that status
   * immediately after the load and skip (uncounted, without `onError`; this is a stale scan entry, not an
   * unrecoverable failure) when it no longer matches what the scan expected: the published branch will not
   * re-publish a projection for a candidate that has since been withdrawn, and the withdrawn branch will not
   * unpublish one that has since been re-published. The other branch's own pass (this reconcile or the next)
   * converges the skipped entry instead. Serializing the whole scan+load sequence against every per-tenant lock
   * bucket (two-phase locking) would close this window entirely; that is a structural follow-up, not implemented
   * here.
   *
   * Also backfills the audit event for either direction: publish's `component.published` record and unpublish's
   * `component.withdrawn` record are both fail-open (see handlePublish / handleUnpublish above), so a storage
   * hiccup there can leave a published/withdrawn snapshot with no matching audit event on the log. For every
   * published snapshot with a persisted draft, reconcile checks for an existing `component.published` event (by
   * artifactId + tenant) and, if none is found, records one with `reconciled: true` as the audit marker
   * (distinguishing it from the original synchronous record); symmetrically for a withdrawn snapshot and
   * `component.withdrawn` (matched by `from: "published"`, so a pre-promotion withdraw's own withdrawn event
   * does not satisfy this check). A second reconcile finds the backfilled event and does not duplicate it. Note
   * this means `reconciled:true` events are counted the same as any other event of that type by lineage's
   * analytics aggregation.
   *
   * Returns a summary (`ReconcileSummary`, #11) of how many published/withdrawn projections were re-applied and
   * how many snapshots were skipped because the data needed to rebuild the projection was unrecoverable (a
   * published snapshot with no draft and no html anywhere, reported individually via
   * `onError({endpoint: "promotion.reconcile.projection"})` — the snapshot itself is untouched either way, so it
   * is retried on the next reconcile). The race-driven skips described above are deliberately not counted here
   * (they are not failures).
   *
   * N+1 avoidance: before the loop, this builds the same kind of bulk indexes `scanCandidatesWithTenant` /
   * `listByStatus` already build once instead of once per candidate — a usage index (`usage.index`), the latest
   * `component.generated` per `(tenant, artifactId)` (fed into `store.load` as `generatedEvent`, falling back to
   * `loadCandidate`'s own per-artifact lookup for anything outside `GENERATED_SCAN_WINDOW`), and an
   * existing-audit-record index for both `component.published` and `component.withdrawn(from:"published")` (so
   * the per-candidate backfill check below is a Set lookup rather than its own `listLineage` round trip).
   */
  async function reconcile(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { published: 0, withdrawn: 0, skipped: 0 };
    if (opts.onPublish == null && opts.onUnpublish == null) return summary;
    // Scan snapshots across all tenants (listPromotionStates with tenant omitted returns all). Each state has .tenant.
    const states = await opts.storage.listPromotionStates();
    const usedByArtifact = await usage.index(undefined);
    const generatedEvents = await opts.storage.listLineage({
      type: ["component.generated"],
      limit: GENERATED_SCAN_WINDOW,
    });
    const latestGeneratedByKey = indexLatestGenerated(generatedEvents);
    const publishedAuditKeys = new Set(
      (
        await opts.storage.listLineage({ type: ["component.published"], limit: RECONCILE_AUDIT_SCAN_WINDOW })
      ).map((e) => usageIndexKey(e.tenant, e.payload["artifactId"] as string)),
    );
    const withdrawnFromPublishedAuditKeys = new Set(
      (await opts.storage.listLineage({ type: ["component.withdrawn"], limit: RECONCILE_AUDIT_SCAN_WINDOW }))
        .filter((e) => e.payload["from"] === "published")
        .map((e) => usageIndexKey(e.tenant, e.payload["artifactId"] as string)),
    );
    for (const state of states) {
      // Only published/withdrawn snapshots can have a projection to converge (see mayHaveProjection's doc).
      // state.status is PromotionState's storage-layer `string` (loosely typed at the StoragePort boundary);
      // cast to PromotionStatus the same way candidate-store.ts's loadCandidate already does for this field.
      if (!mayHaveProjection(state.status as PromotionStatus)) continue;
      const key = usageIndexKey(state.tenant, state.artifactId);
      const loadOptions = {
        tenant: state.tenant,
        usageStats: tallyUsage(usedByArtifact.get(key) ?? []),
        generatedEvent: latestGeneratedByKey.get(key),
      };
      if (state.status === "published") {
        const candidate = await store.load(state.artifactId, loadOptions);
        // Re-check the freshest status right after the load (see this function's doc on the scan/load race): a
        // *real* candidate whose status has since moved off "published" is a stale scan entry, not a failure,
        // so skip it uncounted and without onError -- the withdrawn branch converges it (this reconcile or the
        // next). candidate == null is a different, pre-existing case (loadCandidate found no source data at
        // all) and falls through unchanged to the "unrecoverable" skip+onError path below.
        if (candidate != null && candidate.status !== "published") continue;
        if (candidate?.draft != null && !publishedAuditKeys.has(key)) {
          await recordFailOpen(
            opts.lineage,
            opts.onError,
            "promotion.reconcile.audit",
            "component.published",
            {
              artifactId: state.artifactId,
              componentType: candidate.draft.componentType,
              version: candidate.draft.version,
              intentName: candidate.draft.intentName,
              reconciled: true,
            },
            undefined,
            { tenant: state.tenant, artifactId: state.artifactId },
          );
        }
        if (opts.onPublish == null) continue;
        // The projection cannot be reconstructed unless both draft (state, or the snapshot's own duplicate) and
        // html (snapshot duplicate or component.generated) are present. Anything unrecoverable due to a missing
        // audit log etc. is skipped (the snapshot remains, so it is retried on the next reconcile) and reported.
        if (candidate?.draft == null || candidate.html == null) {
          summary.skipped++;
          notifyPromotionError(
            opts.onError,
            {
              endpoint: "promotion.reconcile.projection",
              artifactId: state.artifactId,
              ...tenantField(state.tenant),
            },
            new Error(
              candidate?.draft == null
                ? `cannot rebuild the published projection for artifact ${state.artifactId}: no schema draft is recorded`
                : `cannot rebuild the published projection for artifact ${state.artifactId}: no html is recorded (neither the snapshot nor component.generated has it)`,
            ),
          );
          continue;
        }
        await opts.onPublish(publishArgs(candidate, state.tenant));
        summary.published++;
        continue;
      }
      // mayHaveProjection admits only "published" (handled above) and "withdrawn", so only withdrawn reaches
      // here: re-apply the projection removal for a withdrawal whose onUnpublish failed partway.
      if (opts.onUnpublish == null) continue;
      const candidate = await store.load(state.artifactId, loadOptions);
      // Re-check the freshest status for the same race as the published branch above (see this function's own
      // doc): a *real* candidate that has since been re-published is a stale scan entry, not a failure, so it
      // is skipped uncounted and without onError rather than incorrectly unpublished -- the published branch
      // converges it instead. candidate == null is a different, pre-existing case (loadCandidate found no
      // source data at all) and falls through unchanged to the "no draft" skip right below.
      if (candidate != null && candidate.status !== "withdrawn") continue;
      // A candidate with no persisted draft was never published (or its draft is unrecoverable), so there is
      // no projection to remove and it is skipped.
      if (candidate?.draft == null) continue;
      // Backfill component.withdrawn for a withdrawn snapshot, symmetric with the published side above: matched
      // by `from: "published"` so a pre-promotion withdraw's own (unrelated) withdrawn event does not suppress
      // this backfill.
      if (!withdrawnFromPublishedAuditKeys.has(key)) {
        await recordFailOpen(
          opts.lineage,
          opts.onError,
          "promotion.reconcile.audit",
          "component.withdrawn",
          { artifactId: state.artifactId, from: "published", reconciled: true },
          undefined,
          { tenant: state.tenant, artifactId: state.artifactId },
        );
      }
      await opts.onUnpublish({
        artifactId: state.artifactId,
        draft: candidate.draft,
        ...tenantField(state.tenant),
      });
      summary.withdrawn++;
    }
    return summary;
  }

  return { list, listByStatus, evaluateAndList, get, act, approve, reject, withdraw, reconcile };
}
