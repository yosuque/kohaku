import { isKohakuHostError } from "@kohaku-ui/client";
import { DEFAULT_APPROVAL_TTL_SECONDS } from "@kohaku-ui/spec-core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { PendingApproval } from "../approvals.js";
import { useAdmin } from "../context.js";
import { useApprovalInbox } from "../hooks.js";
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

function ApprovalRow({ row }: { row: PendingApproval }): ReactNode {
  const { client, messages: t, notify, getMessages } = useAdmin();
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const now = useNowMs(issued != null);

  const issue = () => {
    if (row.requesterId == null) return;
    void client.approvals
      .issue({ action: row.action, payloadHash: row.payloadHash, requesterId: row.requesterId })
      .then((result) => {
        setIssued({ token: result.approval, issuedAt: Date.now() });
        setCopied(false);
        notify(getMessages().approvals.issuedNotice(row.action));
      })
      .catch((e: unknown) => {
        const m = getMessages();
        const denied = isKohakuHostError(e) ? describeDeniedOperation(e, m.approvals.opIssue, m) : null;
        if (denied != null) return notify(denied, "error");
        if (isKohakuHostError(e) && e.status === 400) return notify(m.approvals.selfApproval, "error");
        if (isKohakuHostError(e) && e.status === 501) return notify(m.approvals.notConfigured, "error");
        notify(m.approvals.issueFailed, "error");
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
  const approveDisabled = row.requesterId == null;

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
        <button
          type="button"
          onClick={issue}
          disabled={approveDisabled}
          title={approveDisabled ? t.approvals.requesterUnknown : undefined}
          style={{
            ...smallButton,
            marginLeft: "auto",
            ...(approveDisabled ? { opacity: 0.5, cursor: "not-allowed" } : {}),
          }}
        >
          {t.approvals.approveButton}
        </button>
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: V.muted }}>
        <span>
          {t.approvals.payloadHashLabel}: <code title={row.payloadHash}>{row.payloadHash.slice(0, 12)}</code>
        </span>
        {row.requestIds.length > 0 && (
          <span>
            {t.approvals.requestIdLabel}: <code>{row.requestIds.join(", ")}</code>
          </span>
        )}
      </div>
      {row.payloadHashMismatch === true && (
        <div role="alert" style={{ color: V.negativeText, fontSize: 12.5 }}>
          {t.approvals.payloadMismatch}
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
  const { pending, reload, loading } = useApprovalInbox();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ fontSize: 13, color: V.muted }}>{t.approvals.description}</div>
        <button type="button" onClick={reload} style={{ ...smallButton, marginLeft: "auto" }}>
          {t.refresh}
        </button>
      </div>
      {!loading && pending.length === 0 && (
        <div style={{ ...card, fontSize: 12.5, color: V.muted }}>{t.approvals.empty}</div>
      )}
      {pending.map((row) => (
        <ApprovalRow key={row.key} row={row} />
      ))}
    </div>
  );
}
