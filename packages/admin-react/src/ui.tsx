import type { CSSProperties, ReactNode } from "react";
import { V } from "./theme.js";

export type NoticeKind = "info" | "error";
export type NotifyFn = (text: string, kind?: NoticeKind) => void;

export function ErrorBanner(props: {
  text: string;
  kind?: NoticeKind;
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
        background: kind === "error" ? V.negativeSurface : V.positiveSurface,
        color: kind === "error" ? V.negativeText : V.positiveText,
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
      <div style={{ fontSize: 11.5, color: V.muted }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: V.text, marginTop: 2 }}>{value}</div>
      {sub != null && <div style={{ fontSize: 11, color: V.muted, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

/** A simple inline bar (ratio via div width; no chart library). */
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
      <span style={{ width: 90, color: V.muted, fontFamily: "ui-monospace, monospace" }}>{label}</span>
      <div style={{ flex: 1, background: V.surface, borderRadius: 4, height: 14, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, background: color, height: "100%" }} />
      </div>
      <span style={{ width: 72, textAlign: "right", color: V.muted }}>
        {value}({pct.toFixed(0)}%)
      </span>
    </div>
  );
}

export function Empty({ text }: { text: string }): ReactNode {
  return <div style={{ fontSize: 12, color: V.muted, padding: "4px 0" }}>{text}</div>;
}

export const sectionTitle: CSSProperties = { fontWeight: 700, fontSize: 13, marginBottom: 8, color: V.text };

export function StatusBadge({ status }: { status: string }): ReactNode {
  const colors: Record<string, { bg: string; fg: string }> = {
    in_use: { bg: V.surface, fg: V.muted },
    candidate: { bg: V.warningSurface, fg: V.warningText },
    judging: { bg: V.warningSurface, fg: V.warningText },
    judge_failed: { bg: V.negativeSurface, fg: V.negativeText },
    in_review: { bg: V.infoSurface, fg: V.infoText },
    changes_requested: { bg: V.warningSurface, fg: V.warningText },
    approved: { bg: V.infoSurface, fg: V.infoText },
    schema_proposed: { bg: V.positiveSurface, fg: V.positiveText },
    published: { bg: V.positiveSurface, fg: V.positiveText },
    rejected: { bg: V.negativeSurface, fg: V.negativeText },
    withdrawn: { bg: V.surface, fg: V.muted },
  };
  const c = colors[status] ?? { bg: V.infoSurface, fg: V.infoText };
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

const fieldLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  fontSize: 11.5,
  color: V.muted,
};
const fieldInput: CSSProperties = {
  border: `1px solid ${V.border}`,
  borderRadius: 6,
  padding: "6px 9px",
  fontSize: 12.5,
  fontFamily: "ui-monospace, monospace",
  background: V.background,
  color: V.text,
};

export function Field(props: { label: string; value: string; onChange: (v: string) => void }): ReactNode {
  return (
    <label style={fieldLabel}>
      {props.label}
      <input value={props.value} onChange={(e) => props.onChange(e.target.value)} style={fieldInput} />
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
    <label style={fieldLabel}>
      {props.label}
      <textarea
        value={props.value}
        rows={props.rows}
        onChange={(e) => props.onChange(e.target.value)}
        style={{ ...fieldInput, fontSize: 12, resize: "vertical" }}
      />
    </label>
  );
}

/** Shared `<select>` style (status filter, queryTemplate.path). */
export const selectStyle: CSSProperties = { ...fieldInput, fontFamily: undefined };

export const card: CSSProperties = {
  background: V.background,
  border: `1px solid ${V.border}`,
  borderRadius: 12,
  padding: 16,
};

export const smallButton: CSSProperties = {
  border: `1px solid ${V.border}`,
  background: V.background,
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 12,
  cursor: "pointer",
  color: V.muted,
};
