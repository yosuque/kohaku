import { isKohakuHostError } from "@kohaku-ui/client";
import type { ReactNode } from "react";
import { useAdmin } from "../context.js";
import { useFixations } from "../hooks.js";
import { describeDeniedOperation } from "../rbac.js";
import { V } from "../theme.js";
import { card, smallButton } from "../ui.js";

/**
 * Fixation (L1→L0): proposals from frequent, structurally stable L1 intents, and the fixated records.
 * No refresh button (unlike Lineage/Analytics) — matches the original sample tab, which has none either.
 */
export function FixationsTab(): ReactNode {
  const { client, messages: t, notify, getMessages } = useAdmin();
  const { proposals, records, fixationMinUses, reload } = useFixations();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ fontSize: 13, color: V.muted }}>{t.fixations.description}</div>
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{t.fixations.candidatesTitle}</div>
        {proposals.length === 0 && (
          <div style={{ fontSize: 12.5, color: V.muted }}>
            {fixationMinUses != null ? t.fixations.candidatesEmpty(fixationMinUses) : t.emptyDefault}
          </div>
        )}
        {proposals.map((p) => (
          <div
            key={p.intentHash}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", fontSize: 13 }}
          >
            <code style={{ fontSize: 12 }}>{p.canonical}</code>
            <span style={{ color: V.muted, fontSize: 12 }}>
              {JSON.stringify(p.params ?? {})} /{" "}
              {t.fixations.usesStability(p.uses, (p.stability * 100).toFixed(0))}
            </span>
            <button
              type="button"
              onClick={() => {
                void client.fixations
                  .approve({ canonical: p.canonical, params: p.params ?? {} })
                  .then(() => {
                    notify(getMessages().fixations.fixatedNotice(p.canonical));
                    reload();
                  })
                  .catch((e: unknown) => {
                    const m = getMessages();
                    const denied = isKohakuHostError(e)
                      ? describeDeniedOperation(e, m.fixations.opApprove, m)
                      : null;
                    notify(denied ?? m.fixations.fixateFailed, "error");
                  });
              }}
              style={{ ...smallButton, marginLeft: "auto" }}
            >
              {t.fixations.fixateButton}
            </button>
          </div>
        ))}
      </div>
      <div style={card}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>{t.fixations.fixatedTitle}</div>
        {records.length === 0 && <div style={{ fontSize: 12.5, color: V.muted }}>{t.fixations.none}</div>}
        {records.map((f) => (
          <div
            key={f.intentHash}
            style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0", fontSize: 13 }}
          >
            <code style={{ fontSize: 12 }}>{f.canonical}</code>
            <span style={{ color: V.muted, fontSize: 12 }}>{f.fixatedAt.slice(0, 19)}</span>
            <button
              type="button"
              onClick={() => {
                void client.fixations
                  .unfixate(f.intentHash)
                  .then(() => reload())
                  .catch((e: unknown) => {
                    const m = getMessages();
                    const denied = isKohakuHostError(e)
                      ? describeDeniedOperation(e, m.fixations.opRemove, m)
                      : null;
                    notify(denied ?? m.fixations.removeFailed, "error");
                  });
              }}
              style={{ ...smallButton, marginLeft: "auto" }}
            >
              {t.fixations.removeButton}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
