import {
  type ComponentDraft,
  isKohakuHostError,
  type KohakuClient,
  type PromotionAction,
  type PromotionCandidateView,
} from "@kohaku-ui/client";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useAdmin } from "../../context.js";
import { usePromotions } from "../../hooks.js";
import type { AdminMessages } from "../../messages.js";
import { describeDeniedOperation } from "../../rbac.js";
import { V } from "../../theme.js";
import { card, type NotifyFn, selectStyle, smallButton } from "../../ui.js";
import { DEFAULT_QUERY_PATHS, type DraftForm, genericInitialDraft, type PromotionDefaults } from "./draft.js";
import { type PromotionActionKind, type PromotionActionOptions, PromotionCard } from "./PromotionCard.js";
import { draftFormFromSuggestion } from "./suggestion.js";

/** Status filter choices. "all" (no status) and every other value are the same read-only GET ?status= route. */
export const PROMOTION_STATUS_FILTERS = [
  "all",
  "in_use",
  "candidate",
  "judging",
  "judge_failed",
  "in_review",
  "changes_requested",
  "approved",
  "schema_proposed",
  "published",
  "rejected",
  "withdrawn",
] as const;

type NamedAction = Exclude<PromotionActionKind, "requestChanges">;

/** Runs one of the four named promotion transitions via the typed SDK. Throws KohakuHostError on failure. */
function performPromotionAction(
  client: KohakuClient,
  candidate: PromotionCandidateView,
  kind: NamedAction,
  draft?: ComponentDraft,
  opts?: PromotionActionOptions,
): Promise<PromotionCandidateView> {
  switch (kind) {
    case "approve":
      return client.promotions.approve(candidate.artifactId, draft!, opts);
    case "reject":
      return client.promotions.reject(candidate.artifactId);
    case "withdraw":
    case "unpublish":
      // Both transitions ride the same wire route (POST .../withdraw); only the reviewer-facing operation
      // label and success notice differ, by which side of "published" the candidate was on.
      return client.promotions.withdraw(candidate.artifactId);
  }
}

/** The governance-operation label (for describeDeniedOperation's role explanation), keyed by action kind. */
function opLabelFor(kind: NamedAction, m: AdminMessages): string {
  return {
    approve: m.promotions.opApprove,
    withdraw: m.promotions.opWithdraw,
    unpublish: m.promotions.opUnpublish,
    reject: m.promotions.opReject,
  }[kind];
}

/** The success notice text, keyed by action kind. approve depends on the pre-action status (resubmit vs. first promotion), so it is a function. */
function successNoticeFor(
  kind: NamedAction,
  candidate: PromotionCandidateView,
  draft: ComponentDraft | undefined,
  m: AdminMessages,
): string {
  if (kind === "approve") {
    const d = draft!;
    return candidate.status === "changes_requested"
      ? m.promotions.reApprovedNotice(d.componentType, d.version)
      : m.promotions.promotedNotice(d.componentType, d.version, d.intentName);
  }
  return {
    withdraw: m.promotions.withdrawnNotice,
    unpublish: m.promotions.unpublishedNotice,
    reject: m.promotions.rejectedNotice,
  }[kind];
}

/**
 * Transitions a candidate to changes_requested (sent back), for demonstrating the changes-requested recovery
 * path. candidate → review.start + review.requestChanges; in_review → review.requestChanges. Any step failure
 * (including CAPABILITY_DENIED) throws as-is — unlike approve/reject/withdraw/unpublish, the caller does not
 * apply describeDeniedOperation's explanation here.
 */
async function requestChanges(client: KohakuClient, candidate: PromotionCandidateView): Promise<void> {
  const steps: PromotionAction[] =
    candidate.status === "candidate"
      ? [{ kind: "review.start" }, { kind: "review.requestChanges", comment: "Demo: request changes" }]
      : [{ kind: "review.requestChanges", comment: "Demo: request changes" }];
  for (const action of steps) await client.promotions.act(candidate.artifactId, action);
}

/**
 * Runs one promotion action end-to-end (the wire call, the success/denied/failed notice) and reports whether it
 * succeeded, so the caller knows whether to `reload()`. Pulled out of the card's JSX so PromotionCard's onAction
 * prop can be a single object identity shared by every card (see PromotionCardProps' onAction doc comment).
 */
async function runPromotionAction(
  client: KohakuClient,
  candidate: PromotionCandidateView,
  kind: PromotionActionKind,
  draft: ComponentDraft | undefined,
  opts: PromotionActionOptions | undefined,
  messages: AdminMessages,
  notify: NotifyFn,
): Promise<boolean> {
  try {
    if (kind === "requestChanges") {
      await requestChanges(client, candidate);
      notify(messages.promotions.requestChangesNotice);
      return true;
    }
    // Approve/reject/withdraw/unpublish are all promoted to first-class named routes in host-rest.
    // The approve draft is already the wire form including paramsJsonSchema / queryTemplate.
    await performPromotionAction(client, candidate, kind, draft, opts);
    notify(successNoticeFor(kind, candidate, draft, messages));
    return true;
  } catch (e) {
    // For 401 (session) / 403 CAPABILITY_DENIED (role), show that explanation in a red banner. Others are
    // treated as failures. requestChanges does not get this treatment: its own failures always fall through to
    // failedNotice below.
    if (kind !== "requestChanges" && isKohakuHostError(e)) {
      const denied = describeDeniedOperation(e, opLabelFor(kind, messages), messages);
      if (denied != null) {
        notify(denied, "error");
        return false;
      }
    }
    notify(messages.promotions.failedNotice(e instanceof Error ? e.message : String(e)), "error");
    return false;
  }
}

export function PromotionsTab(props: { defaults?: PromotionDefaults } = {}): ReactNode {
  const { client, messages: t, notify, getMessages } = useAdmin();
  const queryPaths = props.defaults?.queryPaths ?? DEFAULT_QUERY_PATHS;
  const initialDraftFor = props.defaults?.initialDraftFor ?? genericInitialDraft;
  const preferSuggestion = props.defaults?.preferSuggestion ?? true;
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [busyArtifactId, setBusyArtifactId] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const { candidates, promotionMinUses, reload } = usePromotions(statusFilter);

  // Recomputed only when the candidate list itself changes (a reload), not on every render (e.g. while another
  // card is busy) — the suggestion (if present) wins over the product's own `initialDraftFor`.
  const initialDrafts = useMemo(() => {
    const map = new Map<string, DraftForm>();
    for (const c of candidates) {
      map.set(
        c.artifactId,
        preferSuggestion && c.suggestion != null ? draftFormFromSuggestion(c.suggestion) : initialDraftFor(c),
      );
    }
    return map;
  }, [candidates, preferSuggestion, initialDraftFor]);

  const handleAction = useCallback(
    (
      candidate: PromotionCandidateView,
      kind: PromotionActionKind,
      draft?: ComponentDraft,
      opts?: PromotionActionOptions,
    ) => {
      setBusyArtifactId(candidate.artifactId);
      void runPromotionAction(client, candidate, kind, draft, opts, getMessages(), notify)
        .then((ok) => {
          if (ok) reload();
        })
        .finally(() => setBusyArtifactId(null));
    },
    [client, getMessages, notify, reload],
  );

  const handleEvaluate = useCallback(async () => {
    setEvaluating(true);
    try {
      await client.promotions.evaluate();
      reload();
    } catch (e) {
      const m = getMessages();
      const denied = isKohakuHostError(e) ? describeDeniedOperation(e, m.promotions.opEvaluate, m) : null;
      notify(denied ?? m.promotions.failedNotice(e instanceof Error ? e.message : String(e)), "error");
    } finally {
      setEvaluating(false);
    }
  }, [client, notify, getMessages, reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: V.muted, flex: 1, minWidth: 280 }}>{t.promotions.description}</div>
        <button type="button" disabled={evaluating} onClick={() => void handleEvaluate()} style={smallButton}>
          {t.promotions.evaluateButton}
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: V.muted }}>
          {t.promotions.statusLabel}
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
            {PROMOTION_STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? t.promotions.statusAllOption : value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {candidates.length === 0 && (
        <div style={card}>
          {statusFilter === "all"
            ? promotionMinUses != null
              ? t.promotions.emptyAll(promotionMinUses)
              : t.emptyDefault
            : t.promotions.emptyStatus(statusFilter)}
        </div>
      )}
      {candidates.map((candidate) => (
        <PromotionCard
          // Keyed on the suggestion's own identity too, not just artifactId: a candidate can be listed without a
          // suggestion and later gain one (e.g. after a reload while a re-scan attaches an extraction). Without
          // this, the card would not remount, the useState-initialized form would keep its stale prefill, and the
          // acknowledgement checkbox would not reset even though a brand-new proposal just appeared.
          key={`${candidate.artifactId}:${candidate.suggestion?.suggestedAt ?? ""}`}
          candidate={candidate}
          busy={busyArtifactId === candidate.artifactId}
          initialDraft={initialDrafts.get(candidate.artifactId)!}
          queryPaths={queryPaths}
          onAction={handleAction}
        />
      ))}
    </div>
  );
}
