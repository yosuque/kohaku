import { isKohakuHostError, type PromotionPreviewView } from "@kohaku-ui/client";
import { SandboxFrame } from "@kohaku-ui/sandbox/react";
import { type ComponentNode, type JsonValue, SANDBOX_HTML_TYPE, type UISpec } from "@kohaku-ui/spec-core";
import { type ReactNode, useMemo, useState } from "react";
import { useAdmin } from "../../context.js";
import { describeDeniedOperation } from "../../rbac.js";
import { V } from "../../theme.js";
import { ErrorBanner, smallButton } from "../../ui.js";

/**
 * Mounts the recorded artifact (the very thing under review) directly in the same SandboxFrame (isolated
 * iframe, network-blocked) as the chat surface. No re-compose, so what is displayed and what is approved are
 * identical by sha256. Data is proxy-resolved by the parent bridge with the read capability the preview API
 * issued for the single generation-time ref (the capability never enters the iframe).
 */
export function PromotionPreview({ artifactId }: { artifactId: string }): ReactNode {
  const { client, messages: t, getMessages, theme } = useAdmin();
  const [material, setMaterial] = useState<PromotionPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const binding = useMemo(
    () => (material?.capability != null ? client.binding({ capability: material.capability }) : null),
    [client, material?.capability],
  );

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const preview = await client.promotions.preview(artifactId);
      if (preview == null) {
        setError(getMessages().promotions.previewMalformed);
        return;
      }
      setMaterial(preview);
    } catch (e) {
      const m = getMessages();
      const denied = isKohakuHostError(e) ? describeDeniedOperation(e, m.promotions.opPreview, m) : null;
      setError(denied ?? m.promotions.previewFetchFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  };

  if (material == null) {
    return (
      <div style={{ margin: "6px 0" }}>
        <button type="button" disabled={loading} onClick={() => void load()} style={smallButton}>
          {loading ? t.promotions.previewLoading : t.promotions.previewButton}
        </button>
        {error != null && <ErrorBanner text={error} size="sm" role="alert" style={{ marginTop: 6 }} />}
      </div>
    );
  }

  // No events declared (= every guest event is blocked), so the preview is a read-only view.
  const node: ComponentNode = {
    id: `preview-${artifactId}`,
    type: SANDBOX_HTML_TYPE,
    props: {},
    artifact: { inline: material.html, sha256: material.sha256 },
    ...(material.ref != null ? { data: { $ref: material.ref } } : {}),
  };
  const spec: UISpec = {
    kohaku: "0.1",
    intent: { canonical: "admin.promotionPreview", params: {}, hash: `sha256:${"0".repeat(64)}` },
    dataVersion: "preview",
    components: [node],
    events: [],
    provenance: { tier: "L2", composedBy: "admin-preview", cache: "bypass" },
  };

  return (
    <div style={{ margin: "8px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setMaterial(null)} style={smallButton}>
          {t.promotions.closePreview}
        </button>
        {material.ref == null && (
          <span style={{ fontSize: 12, color: V.warningText }}>{t.promotions.previewNoRefWarning}</span>
        )}
      </div>
      <div style={{ border: `1px dashed ${V.border}`, borderRadius: 8, padding: 10 }}>
        <SandboxFrame
          node={node}
          spec={spec}
          theme={theme}
          bridge={{
            resolveBinding: async (ref) => {
              if (binding == null) throw new Error("This candidate has no recorded data reference");
              return (await binding.resolve(ref)) as unknown as JsonValue;
            },
            onEvent: () => {},
            onTelemetry: (event) => {
              // Never sends component.used (the preview must not count as usage).
              if (event.kind === "error")
                console.warn("[kohaku] promotion preview render error", artifactId, event);
            },
          }}
        />
      </div>
    </div>
  );
}
