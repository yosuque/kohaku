import type { UISpec } from "@kohaku-ui/spec-core";
import { type CSSProperties, type ReactNode, useState } from "react";
import { useT } from "../i18n/ui.js";

const TIER_COLORS: Record<string, { bg: string; fg: string }> = {
  L0: { bg: "#dbeafe", fg: "#1e40af" },
  L1: { bg: "#dcfce7", fg: "#166534" },
  L2: { bg: "#ffedd5", fg: "#c2410c" },
};

const CACHE_COLORS: Record<string, { bg: string; fg: string }> = {
  hit: { bg: "#dcfce7", fg: "#166534" },
  miss: { bg: "#f1f5f9", fg: "#475569" },
  bypass: { bg: "#fef9c3", fg: "#854d0e" },
  fixated: { bg: "#dbeafe", fg: "#1e40af" },
};

const chip = (colors: { bg: string; fg: string }): CSSProperties => ({
  background: colors.bg,
  color: colors.fg,
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.3,
});

/**
 * Visualization of provenance (front and center of View Lineage).
 * Displays tier (L0/L1/L2), cache hit, intentHash, model, and dataVersion,
 * so that "why this screen was shown" can be audited on the spot.
 */
export function ProvenanceBadge({ spec }: { spec: UISpec }): ReactNode {
  const [copied, setCopied] = useState(false);
  const t = useT();
  const p = spec.provenance;
  const shortHash = spec.intent.hash.replace("sha256:", "").slice(0, 8);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        color: "var(--app-subtle, #475569)",
      }}
    >
      <span style={chip(TIER_COLORS[p.tier] ?? TIER_COLORS["L1"]!)}>{p.tier}</span>
      <span style={chip(CACHE_COLORS[p.cache] ?? CACHE_COLORS["miss"]!)}>cache:{p.cache.toUpperCase()}</span>
      <button
        type="button"
        title={t.chrome.copyIntentHashTitle}
        onClick={() => {
          void navigator.clipboard.writeText(spec.intent.hash);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        style={{
          border: "1px solid var(--app-border, #e5e7eb)",
          background: "var(--app-elevated, #fff)",
          color: "inherit",
          borderRadius: 4,
          padding: "2px 8px",
          fontSize: 11.5,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        intent:{shortHash}… {copied ? "✓" : "⧉"}
      </button>
      {p.model != null && <span>model:{p.model}</span>}
      <span>dataVer:{spec.dataVersion.split("@")[1] ?? spec.dataVersion}</span>
      {p.fallback != null && (
        <span style={chip({ bg: "#fee2e2", fg: "#991b1b" })} title={p.fallback.reason}>
          fallback
        </span>
      )}
    </div>
  );
}
