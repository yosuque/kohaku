import type { FixationProposalView, FixationRecordView } from "@kohaku-ui/client";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { t as dict, useT } from "../../i18n/ui.js";
import { analytics, fixations } from "../../kohaku/client.js";
import { card, deniedMessage, isKohakuHostError, type PushNotice, smallButton } from "./ui.js";

export function FixationsTab({ onNotice }: { onNotice: PushNotice }): ReactNode {
  const [proposals, setProposals] = useState<FixationProposalView[]>([]);
  const [records, setRecords] = useState<FixationRecordView[]>([]);
  // The fixation-nomination threshold behind the "N or more uses" empty-state copy, sourced from
  // GET /analytics/summary's promotionPolicy rather than a literal so it cannot drift from the server's
  // actual policy. null until loaded (or if the host does not bundle it), in which case a generic
  // number-free message is shown instead of guessing a number.
  const [fixationMinUses, setFixationMinUses] = useState<number | null>(null);
  const t = useT();
  const reload = useCallback(() => {
    void fixations.proposals().then(setProposals);
    void fixations.list().then(setRecords);
    void analytics.summary().then((s) => setFixationMinUses(s.promotionPolicy?.fixationMinUses ?? null));
  }, []);
  useEffect(reload, [reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, color: "var(--app-muted, #6b7280)" }}>{t.admin.fixations.description}</div>
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
          {t.admin.fixations.candidatesTitle}
        </div>
        {proposals.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--app-muted, #9ca3af)" }}>
            {fixationMinUses != null
              ? t.admin.fixations.candidatesEmpty(fixationMinUses)
              : t.admin.emptyDefault}
          </div>
        )}
        {proposals.map((p) => (
          <div
            key={p.intentHash}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", fontSize: 13 }}
          >
            <code style={{ fontSize: 12 }}>{p.canonical}</code>
            <span style={{ color: "var(--app-muted, #6b7280)", fontSize: 12 }}>
              {JSON.stringify(p.params ?? {})} /{" "}
              {t.admin.fixations.usesStability(p.uses, (p.stability * 100).toFixed(0))}
            </span>
            <button
              type="button"
              onClick={() => {
                void fixations
                  .approve({ canonical: p.canonical, params: p.params ?? {} })
                  .then(() => {
                    onNotice(dict().admin.fixations.fixatedNotice(p.canonical));
                    reload();
                  })
                  .catch((e: unknown) => {
                    const denied = isKohakuHostError(e)
                      ? deniedMessage(e, dict().admin.fixations.opApprove)
                      : null;
                    onNotice(denied ?? dict().admin.fixations.fixateFailed, "error");
                  });
              }}
              style={{ ...smallButton, marginLeft: "auto" }}
            >
              {t.admin.fixations.fixateButton}
            </button>
          </div>
        ))}
      </div>
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{t.admin.fixations.fixatedTitle}</div>
        {records.length === 0 && (
          <div style={{ fontSize: 12.5, color: "var(--app-muted, #9ca3af)" }}>{t.admin.fixations.none}</div>
        )}
        {records.map((f) => (
          <div
            key={f.intentHash}
            style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0", fontSize: 13 }}
          >
            <code style={{ fontSize: 12 }}>{f.canonical}</code>
            <span style={{ color: "var(--app-muted, #9ca3af)", fontSize: 12 }}>
              {f.fixatedAt.slice(0, 19)}
            </span>
            <button
              type="button"
              onClick={() => {
                void fixations
                  .remove(f.intentHash)
                  .then(() => reload())
                  .catch((e: unknown) => {
                    const denied = isKohakuHostError(e)
                      ? deniedMessage(e, dict().admin.fixations.opRemove)
                      : null;
                    onNotice(denied ?? dict().admin.fixations.removeFailed, "error");
                  });
              }}
              style={{ ...smallButton, marginLeft: "auto" }}
            >
              {t.admin.fixations.removeButton}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
