import {
  type ComponentDraft,
  isKohakuHostError,
  type KohakuClient,
  type PromotionAction,
  type PromotionCandidateView,
} from "@kohaku-ui/client";
import { type ReactNode, useState } from "react";
import { useAdmin } from "../../context.js";
import { usePromotions } from "../../hooks.js";
import type { AdminMessages } from "../../messages.js";
import { V } from "../../theme.js";
import { card, deniedMessage, selectStyle } from "../../ui.js";
import { DEFAULT_QUERY_PATHS, type DraftForm, genericInitialDraft, type PromotionDefaults } from "./draft.js";
import { type PromotionActionKind, PromotionCard } from "./PromotionCard.js";
import { draftFormFromSuggestion } from "./suggestion.js";

/** Status filter choices. "all" = evaluate (automatic nomination); the rest are read-only GET ?status=. */
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

/** Runs one of the three named promotion transitions via the typed SDK. Throws KohakuHostError on failure. */
function performPromotionAction(
  client: KohakuClient,
  candidate: PromotionCandidateView,
  kind: NamedAction,
  draft?: ComponentDraft,
): Promise<PromotionCandidateView> {
  switch (kind) {
    case "approve":
      return client.promotions.approve(candidate.artifactId, draft!);
    case "reject":
      return client.promotions.reject(candidate.artifactId);
    case "withdraw":
      return client.promotions.withdraw(candidate.artifactId);
  }
}

/** The governance-operation label (for deniedMessage's role explanation), keyed by action kind. */
function opLabelFor(kind: NamedAction, m: AdminMessages): string {
  return {
    approve: m.promotions.opApprove,
    withdraw: m.promotions.opWithdraw,
    reject: m.promotions.opReject,
  }[kind];
}

/** The success notice text, keyed by action kind. approve depends on the pre-action status (resubmit vs. first promotion), so it is a function. */
function successNoticeFor(
  kind: NamedAction,
  candidate: PromotionCandidateView,
  draft: ComponentDraft,
  m: AdminMessages,
): string {
  if (kind === "approve") {
    return candidate.status === "changes_requested"
      ? m.promotions.reApprovedNotice(draft.componentType, draft.version)
      : m.promotions.promotedNotice(draft.componentType, draft.version, draft.intentName);
  }
  return { withdraw: m.promotions.withdrawnNotice, reject: m.promotions.rejectedNotice }[kind];
}

/**
 * Transitions a candidate to changes_requested (sent back), for demonstrating the changes-requested recovery
 * path. candidate → review.start + review.requestChanges; in_review → review.requestChanges. Any step failure
 * (including CAPABILITY_DENIED) throws as-is — unlike approve/reject/withdraw, the caller does not apply
 * deniedMessage's role explanation here.
 */
async function requestChanges(client: KohakuClient, candidate: PromotionCandidateView): Promise<void> {
  const steps: PromotionAction[] =
    candidate.status === "candidate"
      ? [{ kind: "review.start" }, { kind: "review.requestChanges", comment: "Demo: request changes" }]
      : [{ kind: "review.requestChanges", comment: "Demo: request changes" }];
  for (const action of steps) await client.promotions.act(candidate.artifactId, action);
}

export function PromotionsTab(props: { defaults?: PromotionDefaults } = {}): ReactNode {
  const { client, messages: t, notify, getMessages } = useAdmin();
  const queryPaths = props.defaults?.queryPaths ?? DEFAULT_QUERY_PATHS;
  const initialDraftFor = props.defaults?.initialDraftFor ?? genericInitialDraft;
  const preferSuggestion = props.defaults?.preferSuggestion ?? true;
  /** Suggestion first (it was extracted from this candidate's HTML), the product's generic prefill otherwise. */
  const initialDraftOf = (candidate: PromotionCandidateView): DraftForm =>
    preferSuggestion && candidate.suggestion != null
      ? draftFormFromSuggestion(candidate.suggestion)
      : initialDraftFor(candidate);
  /**
   * The product's own `queryPaths` first, with a suggested `queryTemplate.path` appended when it is not already
   * in that list. Without this, a suggested path outside the product's list would be submitted on approve (the
   * form is prefilled with it) while the <select> shows nothing selected and the diff panel calls it "unchanged" —
   * a reviewer approving a value the UI never displayed.
   */
  const queryPathsFor = (candidate: PromotionCandidateView): readonly string[] => {
    const suggestedPath = candidate.suggestion?.draft.queryTemplate?.path;
    return suggestedPath != null && !queryPaths.includes(suggestedPath)
      ? [...queryPaths, suggestedPath]
      : queryPaths;
  };
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const { candidates, promotionMinUses, reload } = usePromotions(statusFilter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: V.muted, flex: 1, minWidth: 280 }}>{t.promotions.description}</div>
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
          busy={busy}
          initialDraft={initialDraftOf(candidate)}
          queryPaths={queryPathsFor(candidate)}
          onAction={async (kind, draft) => {
            setBusy(true);
            try {
              if (kind === "requestChanges") {
                await requestChanges(client, candidate);
                notify(getMessages().promotions.requestChangesNotice);
                reload();
                return;
              }
              // Approve/reject/withdraw are all promoted to first-class named routes in host-rest.
              // The approve draft is already the wire form including paramsJsonSchema / queryTemplate.
              await performPromotionAction(client, candidate, kind, draft);
              notify(successNoticeFor(kind, candidate, draft!, getMessages()));
              reload();
            } catch (e) {
              // For 403 CAPABILITY_DENIED (viewer, etc.), show a role-oriented explanation in a red banner. Others are treated as failures.
              // requestChanges does not get this treatment: its own failures always fall through to failedNotice below.
              if (kind !== "requestChanges" && isKohakuHostError(e)) {
                const m = getMessages();
                const denied = deniedMessage(e, opLabelFor(kind, m), m);
                if (denied != null) {
                  notify(denied, "error");
                  return;
                }
              }
              notify(
                getMessages().promotions.failedNotice(e instanceof Error ? e.message : String(e)),
                "error",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      ))}
    </div>
  );
}
