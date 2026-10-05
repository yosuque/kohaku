import { isKohakuHostError } from "@kohaku-ui/client";
import { shortPayloadHash } from "@kohaku-ui/renderer-core";
import { DEFAULT_APPROVAL_TTL_SECONDS } from "@kohaku-ui/spec-core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PendingApproval } from "../approvals.js";
import { useAdmin } from "../context.js";
import { APPROVAL_INBOX_EVENT_LIMIT, useApprovalInbox } from "../hooks.js";
import { describeDeniedOperation } from "../rbac.js";
import { V } from "../theme.js";
import { card, smallButton } from "../ui.js";

interface IssuedToken {
  token: string;
  issuedAt: number;
}

/** A once-a-second clock, running only while `active` (an issued token's age and expiry are shown live). */
function useNowMs(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * POST /approvals answers 400 for more than a self-approval (a malformed body, a port-level refusal), so the
 * dedicated self-approval text is chosen from the server's own wording: host-rest's "an approver cannot approve
 * their own request", or the HMAC port's "approverId must differ from requesterId".
 */
function isSelfApprovalMessage(message: string): boolean {
  return /own request|must differ from requesterId/i.test(message);
}

function ApprovalRow({ row }: { row: PendingApproval }): ReactNode {
  const { client, messages: t, notify, getMessages } = useAdmin();
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNowMs(issued != null);

  const issue = () => {
    if (row.requesterId == null) return;
    // The TTL is sent explicitly, so the countdown shown below counts the lifetime this console asked for
    // rather than assuming the host's own default happens to equal it (the host may clamp it down further).
    void client.approvals
      .issue({
        action: row.action,
        payloadHash: row.payloadHash,
        requesterId: row.requesterId,
        ttlSeconds: DEFAULT_APPROVAL_TTL_SECONDS,
      })
      .then((result) => {
        setIssued({ token: result.approval, issuedAt: Date.now() });
        setCopied(false);
        notify(getMessages().approvals.issuedNotice(row.action));
      })
      .catch((e: unknown) => {
        const m = getMessages();
        if (!isKohakuHostError(e)) {
          return notify(m.approvals.issueFailed(e instanceof Error ? e.message : undefined), "error");
        }
        const denied = describeDeniedOperation(e, m.approvals.opIssue, m);
        if (denied != null) return notify(denied, "error");
        if (e.status === 400 && isSelfApprovalMessage(e.message)) {
          return notify(m.approvals.selfApproval, "error");
        }
        if (e.status === 501) return notify(m.approvals.notConfigured, "error");
        notify(m.approvals.issueFailed(e.message, e.requestId), "error");
      });
  };

  const copy = () => {
    if (issued == null) return;
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (clipboard?.writeText == null) {
      inputRef.current?.select();
      return;
    }
    void clipboard
      .writeText(issued.token)
      .then(() => setCopied(true))
      .catch(() => inputRef.current?.select());
  };

  const requestAgeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(row.latestTs)) / 1000));
  const issuedAgeSeconds = issued != null ? Math.max(0, Math.floor((now - issued.issuedAt) / 1000)) : 0;
  const expired = issued != null && issuedAgeSeconds >= DEFAULT_APPROVAL_TTL_SECONDS;
  // Why Approve is unavailable, if it is: no requester to bind the token to, a recorded payload that is not the
  // one the hash covers, or a token that was already issued and is still valid (a new one would only confuse).
  const disabledReason =
    row.requesterId == null
      ? t.approvals.requesterUnknown
      : row.payloadHashState === "mismatch"
        ? t.approvals.approveDisabledMismatch
        : issued != null && !expired
          ? t.approvals.approveDisabledIssued
          : null;
  // After the TTL only Re-issue (next to the token) is offered.
  const showApprove = !expired;

  return (
    <div style={{ ...card, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 13 }}>
        <code style={{ fontSize: 13, fontWeight: 700 }}>{row.action}</code>
        <span style={{ color: V.muted, fontSize: 12 }}>
          {t.approvals.requester}: <code>{row.requesterId ?? "—"}</code>
        </span>
        <span style={{ color: V.muted, fontSize: 12 }}>{t.approvals.age(requestAgeSeconds)}</span>
        {row.count > 1 && (
          <span style={{ color: V.muted, fontSize: 12 }}>{t.approvals.requestCount(row.count)}</span>
        )}
        {showApprove && (
          <button
            type="button"
            onClick={issue}
            disabled={disabledReason != null}
            title={disabledReason ?? undefined}
            style={{
              ...smallButton,
              marginLeft: "auto",
              ...(disabledReason != null ? { opacity: 0.5, cursor: "not-allowed" } : {}),
            }}
          >
            {t.approvals.approveButton}
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: V.muted }}>
        <span>
          {t.approvals.payloadHashLabel}:{" "}
          <code title={row.payloadHash}>{shortPayloadHash(row.payloadHash)}</code>
        </span>
        {row.requestIds.length > 0 && (
          <span>
            {t.approvals.requestIdLabel}: <code>{row.requestIds.join(", ")}</code>
          </span>
        )}
      </div>
      {row.payloadHashState === "mismatch" && (
        <div role="alert" style={{ color: V.negativeText, fontSize: 12.5 }}>
          {t.approvals.payloadMismatch}
        </div>
      )}
      {row.payloadHashState === "unverifiable" && (
        <div role="status" style={{ color: V.muted, fontSize: 12.5 }}>
          {t.approvals.payloadUnverifiable}
        </div>
      )}
      {row.payload !== undefined && (
        <details>
          <summary style={{ fontSize: 12, cursor: "pointer", color: V.muted }}>
            {t.approvals.payloadLabel}
          </summary>
          <pre
            style={{
              margin: "6px 0 0",
              padding: 8,
              background: V.surface,
              borderRadius: 6,
              fontSize: 12,
              overflowX: "auto",
            }}
          >
            {JSON.stringify(row.payload, null, 2)}
          </pre>
        </details>
      )}
      {issued != null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input
            ref={inputRef}
            readOnly
            value={issued.token}
            aria-label={t.approvals.tokenLabel}
            onFocus={(e) => e.currentTarget.select()}
            style={{
              flex: 1,
              minWidth: 200,
              border: `1px solid ${V.border}`,
              borderRadius: 6,
              padding: "6px 9px",
              fontSize: 12,
              fontFamily: "ui-monospace, monospace",
              background: V.background,
              color: V.text,
            }}
          />
          <button type="button" onClick={copy} style={smallButton}>
            {copied ? t.approvals.copied : t.approvals.copyButton}
          </button>
          <span style={{ fontSize: 11.5, color: V.muted }}>
            {t.approvals.issuedAge(issuedAgeSeconds, DEFAULT_APPROVAL_TTL_SECONDS)}
          </span>
          {expired && (
            <button type="button" onClick={issue} style={smallButton}>
              {t.approvals.reissue}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The approver's inbox for `"approve"`-tier governed Actions (design.md #72). Pending requests are derived from
 * the lineage tail; Approve mints a bearer token (POST /approvals) that is shown here for the approver to copy
 * and hand to the requester. The console never stores the token: it lives in the row's local state only.
 */
export function ApprovalsTab(): ReactNode {
  const { messages: t } = useAdmin();
  const { pending, reload, loading, windowFull } = useApprovalInbox();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 13, color: V.muted }}>{t.approvals.description}</div>
        <button type="button" onClick={reload} style={{ ...smallButton, marginLeft: "auto" }}>
          {t.refresh}
        </button>
      </div>
      {windowFull && (
        <div role="status" style={{ ...card, fontSize: 12.5, color: V.muted }}>
          {t.approvals.windowFull(APPROVAL_INBOX_EVENT_LIMIT)}
        </div>
      )}
      {!loading && pending.length === 0 && (
        <div style={{ ...card, fontSize: 12.5, color: V.muted }}>{t.approvals.empty}</div>
      )}
      {pending.map((row) => (
        <ApprovalRow key={row.key} row={row} />
      ))}
    </div>
  );
}
