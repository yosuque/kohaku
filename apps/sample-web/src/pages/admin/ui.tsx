import { isKohakuHostError, type KohakuHostError } from "@kohaku-ui/client";
import type { CSSProperties, ReactNode } from "react";
import { t } from "../../i18n/ui.js";

/** Notification for governance routes (green = info / red = error, 403). */
export type Notice = { text: string; kind: "info" | "error" };
export type PushNotice = (text: string, kind?: "info" | "error") => void;

export type { KohakuHostError };
export { isKohakuHostError };

/**
 * If a governance call's thrown error is 403 CAPABILITY_DENIED (declarative RBAC #1), returns an explanation for
 * the role. Otherwise returns null. The SDK client throws KohakuHostError on any !ok response (client.ts's
 * parse()), so callers pass the caught exception straight through (no more hand-written status/body checks).
 * The message (and the operation label the caller passes) comes from the ui.ts dictionary at call time.
 */
export function deniedMessage(err: KohakuHostError, operation: string): string | null {
  if (err.code === "CAPABILITY_DENIED") {
    return t().admin.deniedMessage(err.code, operation);
  }
  return null;
}

export const TIER_COLOR: Record<string, string> = { L0: "#1e40af", L1: "#166534", L2: "#c2410c" };

/**
 * A colored inline notification banner (green = info / red = error). Unifies the near-duplicate error/notice
 * divs across pages (ChatPage's ErrorBubble, DashboardPage's error div, PromotionsTab's two inline validation /
 * preview-failure banners, and AdminPage's push-notice banner). `size` and `role` let each call site match its
 * own look; `style` merges on top for any remaining one-off (e.g. AdminPage's marginBottom).
 */
export function ErrorBanner(props: {
  text: string;
  kind?: "info" | "error";
  size?: "sm" | "md";
  role?: "alert";
  style?: CSSProperties;
}): ReactNode {
  const kind = props.kind ?? "error";
  const sizing: CSSProperties =
    props.size === "sm"
      ? { borderRadius: 6, padding: "6px 10px", fontSize: 12 }
      : { borderRadius: 8, padding: "10px 14px", fontSize: 13 };
  return (
    <div
      role={props.role}
      style={{
        background: kind === "error" ? "#fee2e2" : "#ecfdf5",
        color: kind === "error" ? "#991b1b" : "#065f46",
        ...sizing,
        ...props.style,
      }}
    >
      {props.text}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}): ReactNode {
  return (
    <div style={card}>
      <div style={{ fontSize: 11.5, color: "var(--app-muted, #6b7280)" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: "var(--app-text, #1e293b)", marginTop: 2 }}>
        {value}
      </div>
      {sub != null && (
        <div style={{ fontSize: 11, color: "var(--app-muted, #9ca3af)", marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

/** A simple inline bar (visualizes the ratio via div width. Does not add a new chart library). */
export function BarRow({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}): ReactNode {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12 }}>
      <span style={{ width: 90, color: "var(--app-subtle, #475569)", fontFamily: "ui-monospace, monospace" }}>
        {label}
      </span>
      <div
        style={{
          flex: 1,
          background: "var(--app-track, #f1f5f9)",
          borderRadius: 4,
          height: 14,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, background: color, height: "100%" }} />
      </div>
      <span style={{ width: 72, textAlign: "right", color: "var(--app-muted, #6b7280)" }}>
        {value}({pct.toFixed(0)}%)
      </span>
    </div>
  );
}

export function Empty({ text }: { text?: string }): ReactNode {
  return (
    <div style={{ fontSize: 12, color: "var(--app-muted, #9ca3af)", padding: "4px 0" }}>
      {text ?? t().admin.emptyDefault}
    </div>
  );
}

export const sectionTitle: CSSProperties = {
  fontWeight: 700,
  fontSize: 13,
  marginBottom: 8,
  color: "var(--app-text, #334155)",
};

export function StatusBadge({ status }: { status: string }): ReactNode {
  const colors: Record<string, { bg: string; fg: string }> = {
    in_use: { bg: "#f1f5f9", fg: "var(--app-subtle, #475569)" },
    candidate: { bg: "#fef3c7", fg: "#92400e" },
    judging: { bg: "#fef9c3", fg: "#854d0e" },
    judge_failed: { bg: "#ffe4e6", fg: "#9f1239" },
    in_review: { bg: "#e0f2fe", fg: "#075985" },
    changes_requested: { bg: "#ffedd5", fg: "#9a3412" },
    approved: { bg: "#eef2ff", fg: "#3730a3" },
    schema_proposed: { bg: "#ccfbf1", fg: "#115e59" },
    published: { bg: "#dcfce7", fg: "#166534" },
    rejected: { bg: "#fee2e2", fg: "#991b1b" },
    withdrawn: { bg: "#f1f5f9", fg: "#64748b" },
  };
  const c = colors[status] ?? { bg: "#eef2ff", fg: "#3730a3" };
  return (
    <span
      style={{
        background: c.bg,
        color: c.fg,
        borderRadius: 4,
        padding: "2px 8px",
        fontSize: 11.5,
        fontWeight: 700,
      }}
    >
      {status}
    </span>
  );
}

export function Field(props: { label: string; value: string; onChange: (v: string) => void }): ReactNode {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        fontSize: 11.5,
        color: "var(--app-muted, #6b7280)",
      }}
    >
      {props.label}
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        style={{
          border: "1px solid var(--app-border, #e5e7eb)",
          borderRadius: 6,
          padding: "6px 9px",
          fontSize: 12.5,
          fontFamily: "ui-monospace, monospace",
        }}
      />
    </label>
  );
}

export function TextAreaField(props: {
  label: string;
  value: string;
  rows: number;
  onChange: (v: string) => void;
}): ReactNode {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        fontSize: 11.5,
        color: "var(--app-muted, #6b7280)",
      }}
    >
      {props.label}
      <textarea
        value={props.value}
        rows={props.rows}
        onChange={(e) => props.onChange(e.target.value)}
        style={{
          border: "1px solid var(--app-border, #e5e7eb)",
          borderRadius: 6,
          padding: "6px 9px",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          resize: "vertical",
        }}
      />
    </label>
  );
}

export const card: CSSProperties = {
  background: "var(--app-elevated, #fff)",
  border: "1px solid var(--app-border, #e5e7eb)",
  borderRadius: 12,
  padding: 16,
};

export const smallButton: CSSProperties = {
  border: "1px solid var(--app-border, #e5e7eb)",
  background: "var(--app-elevated, #fff)",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
  color: "var(--app-subtle, #475569)",
};
