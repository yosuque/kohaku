import type { ComponentDraft, PromotionCandidateView } from "@kohaku-ui/client";
import { type ReactNode, useMemo, useState } from "react";
import { useAdmin } from "../../context.js";
import { V } from "../../theme.js";
import { card, ErrorBanner, StatusBadge, smallButton } from "../../ui.js";
import { buildDraftPayload, type DraftForm } from "./draft.js";
import { PromotionDraftEditor } from "./PromotionDraftEditor.js";
import { PromotionPreview } from "./PromotionPreview.js";
import { SuggestionPanel } from "./SuggestionPanel.js";
import { diffAgainstSuggestion } from "./suggestion.js";

export type PromotionActionKind = "approve" | "reject" | "withdraw" | "requestChanges";

export interface PromotionCardProps {
  candidate: PromotionCandidateView;
  busy: boolean;
  onAction: (kind: PromotionActionKind, draft?: ComponentDraft) => Promise<void>;
  /** The form's initial state (from PromotionDefaults.initialDraftFor). Read once on mount. */
  initialDraft: DraftForm;
  queryPaths: readonly string[];
}

export function PromotionCard(props: PromotionCardProps): ReactNode {
  const { candidate } = props;
  const { messages: t } = useAdmin();
  const [draft, setDraft] = useState<DraftForm>(props.initialDraft);
  const suggestion = candidate.suggestion ?? null;
  const [acknowledged, setAcknowledged] = useState(false);
  const diff = useMemo(
    () => (suggestion != null ? diffAgainstSuggestion(draft, suggestion) : []),
    [draft, suggestion],
  );
  // The approve button stays disabled until the reviewer confirms they compared the proposal with the preview.
  const needsAcknowledgement = suggestion != null && !acknowledged;
  const terminal = ["published", "rejected", "withdrawn"].includes(candidate.status);
  // changes_requested (sent back) is non-terminal, and approval is restored as the "resubmit and approve" path.
  const isChangesRequested = candidate.status === "changes_requested";
  // "Request changes (send back)" is offered only for candidate / in_review (drops to changes_requested via actions).
  const canRequestChanges = candidate.status === "candidate" || candidate.status === "in_review";
  // reject() (packages/lineage promotion service) only advances from in_use / candidate / in_review.
  const canReject =
    candidate.status === "in_use" || candidate.status === "candidate" || candidate.status === "in_review";
  const built = buildDraftPayload(draft, t);
  const canApprove = built.ok && !needsAcknowledgement;

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: V.muted }}>
          {candidate.artifactId}
        </span>
        <StatusBadge status={candidate.status} />
        <span style={{ fontSize: 12.5, color: V.subtle }}>
          {t.promotions.usesSessions(candidate.uses, candidate.sessions)}
        </span>
        {candidate.verdict != null && (
          <span style={{ fontSize: 12, color: candidate.verdict.pass ? V.positiveText : V.negativeText }}>
            judge: {candidate.verdict.pass ? "PASS" : "FAIL"}({candidate.verdict.score})
          </span>
        )}
      </div>
      {isChangesRequested && (
        <div
          style={{
            background: V.changesRequestedSurface,
            color: V.changesRequestedText,
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 12,
            margin: "8px 0",
          }}
        >
          {t.promotions.changesRequestedBanner}
        </div>
      )}
      {candidate.request != null && (
        <div style={{ fontSize: 14, margin: "8px 0", fontWeight: 600 }}>「{candidate.request}」</div>
      )}
      {candidate.html != null && (
        <details style={{ fontSize: 12, margin: "6px 0" }}>
          <summary style={{ cursor: "pointer", color: V.muted }}>
            {t.promotions.generatedHtml((candidate.html.length / 1024).toFixed(1))}
          </summary>
          <pre
            style={{
              background: V.codeBackground,
              color: V.codeText,
              borderRadius: 8,
              padding: 12,
              maxHeight: 280,
              overflow: "auto",
              fontSize: 11,
            }}
          >
            {candidate.html}
          </pre>
        </details>
      )}
      {candidate.html != null && <PromotionPreview artifactId={candidate.artifactId} />}
      {!terminal && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          <PromotionDraftEditor draft={draft} setDraft={setDraft} queryPaths={props.queryPaths} />
          {suggestion != null && (
            <SuggestionPanel
              suggestion={suggestion}
              diff={diff}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
            />
          )}
          {!built.ok && <ErrorBanner text={built.error} size="sm" role="alert" />}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={props.busy || !canApprove}
              onClick={() => built.ok && void props.onAction("approve", built.payload)}
              style={{
                ...smallButton,
                background: canApprove ? V.primary : V.disabledSurface,
                color: V.onPrimary,
                border: "none",
                padding: "8px 18px",
                cursor: canApprove && !props.busy ? "pointer" : "not-allowed",
              }}
            >
              {isChangesRequested ? t.promotions.approveResubmitButton : t.promotions.approveButton}
            </button>
            {canRequestChanges && (
              <button
                type="button"
                disabled={props.busy}
                onClick={() => void props.onAction("requestChanges")}
                style={{
                  ...smallButton,
                  borderColor: V.changesRequestedBorder,
                  color: V.changesRequestedText,
                }}
              >
                {t.promotions.requestChangesButton}
              </button>
            )}
            {isChangesRequested ? (
              <button
                type="button"
                disabled={props.busy}
                onClick={() => void props.onAction("withdraw")}
                style={{ ...smallButton, borderColor: V.negativeBorder, color: V.negativeText }}
              >
                {t.promotions.withdrawButton}
              </button>
            ) : (
              canReject && (
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={() => void props.onAction("reject")}
                  style={smallButton}
                >
                  {t.promotions.rejectButton}
                </button>
              )
            )}
          </div>
        </div>
      )}
      {candidate.status === "published" && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={props.busy}
            onClick={() => void props.onAction("withdraw")}
            style={{ ...smallButton, borderColor: V.negativeBorder, color: V.negativeText }}
          >
            {t.promotions.unpublishButton}
          </button>
        </div>
      )}
    </div>
  );
}
