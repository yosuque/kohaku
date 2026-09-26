import type { ExplainReport, KohakuClient } from "@kohaku-ui/client";
import type { ThemeTokens, UISpec } from "@kohaku-ui/spec-core";
import { type ReactNode, useCallback, useState, useSyncExternalStore } from "react";
import { adminThemeStyle, V } from "../theme.js";
import { card, Empty, ErrorBanner, Field, sectionTitle, smallButton } from "../ui.js";
import type { DevToolsCapture } from "./capture.js";
import { type DevToolsMessages, defaultDevToolsMessages } from "./messages.js";
import { CacheKeyPanel } from "./panels/CacheKeyPanel.js";
import { DecisionPanel } from "./panels/DecisionPanel.js";
import { LineagePanel } from "./panels/LineagePanel.js";
import { ProvenancePanel } from "./panels/ProvenancePanel.js";
import { ScopesPanel } from "./panels/ScopesPanel.js";
import { SpecTreePanel } from "./panels/SpecTreePanel.js";

export interface KohakuDevToolsProps {
  /**
   * Explicit opt-in: nothing renders (not even an empty shell) unless this is `true`. A devtool must never
   * appear in a build by accident -- the caller decides when it is safe to show (e.g. `import.meta.env.DEV`,
   * see apps/sample-web's DevToolsMount).
   */
  enabled: boolean;
  /** Used to call KohakuClient.explain(requestId, {spec}) on demand. */
  client: KohakuClient;
  /** Feeds the "recent requests" quick-pick list. Pass the `capture` half of `withDevToolsCapture`'s result. */
  capture?: DevToolsCapture;
  /**
   * The currently-displayed Spec (if any). Passed through to `client.explain` so the Scopes panel can show
   * `collectCapabilityScopes(spec)`, and rendered by the Spec panel. DevTools never receives composer's own
   * types (ComposeTrace/ComposeAttempt/...) -- only this Spec and the already-serialized ExplainReport JSON
   * `client.explain` returns.
   */
  spec?: UISpec;
  theme?: ThemeTokens;
  messages?: DevToolsMessages;
  /** Pre-fills the request-id field and runs explain once on mount (e.g. the requestId of `spec`'s own compose). */
  defaultRequestId?: string;
}

type PanelKey = "provenance" | "cacheKey" | "decision" | "scopes" | "lineage" | "specTree";

const NO_SUBSCRIBE = (): (() => void) => () => {};
const EMPTY_RECENT: ReturnType<DevToolsCapture["getRecentRequests"]> = [];

/**
 * `@kohaku-ui/admin-react/devtools`'s single component: a request-id field (+ a quick-pick list of recent
 * requests, when `capture` is wired) that fetches an {@link ExplainReport} via `client.explain` and renders
 * it across six panels (Provenance / Cache key / Decision / Scopes / Lineage / Spec). See docs/user-guide.md's
 * DevTools section for the CORS requirement (`Access-Control-Expose-Headers: X-Request-Id`) a browser-hosted
 * client needs for `requestId` to ever be non-empty.
 */
export function KohakuDevTools(props: KohakuDevToolsProps): ReactNode {
  const t = props.messages ?? defaultDevToolsMessages;
  const [requestId, setRequestId] = useState(props.defaultRequestId ?? "");
  const [report, setReport] = useState<ExplainReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [panel, setPanel] = useState<PanelKey>("provenance");
  const client = props.client;
  const spec = props.spec;

  const recent = useSyncExternalStore(
    props.capture?.subscribe ?? NO_SUBSCRIBE,
    () => props.capture?.getRecentRequests() ?? EMPTY_RECENT,
    () => EMPTY_RECENT,
  );

  const runExplain = useCallback(
    async (id: string) => {
      if (id === "") return;
      setLoading(true);
      setError(null);
      try {
        setReport(await client.explain(id, spec != null ? { spec } : undefined));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setReport(null);
      } finally {
        setLoading(false);
      }
    },
    [client, spec],
  );

  if (!props.enabled) return null;

  const panels: { key: PanelKey; label: string }[] = [
    { key: "provenance", label: t.panels.provenance },
    { key: "cacheKey", label: t.panels.cacheKey },
    { key: "decision", label: t.panels.decision },
    { key: "scopes", label: t.panels.scopes },
    { key: "lineage", label: t.panels.lineage },
    { key: "specTree", label: t.panels.specTree },
  ];

  return (
    <div
      style={{ ...adminThemeStyle(props.theme), ...card, display: "flex", flexDirection: "column", gap: 12 }}
    >
      <div style={sectionTitle}>{t.title}</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runExplain(requestId);
        }}
        style={{ display: "flex", gap: 8, alignItems: "flex-end" }}
      >
        <Field label={t.requestIdLabel} value={requestId} onChange={setRequestId} />
        <button type="submit" style={smallButton} disabled={loading || requestId === ""}>
          {t.explainButton}
        </button>
      </form>
      {recent.length > 0 && (
        <div>
          <div style={{ fontSize: 11.5, color: V.muted, marginBottom: 4 }}>{t.recentRequestsLabel}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {recent.map((r, i) => (
              <button
                // Requests can repeat the same requestId (a reused/absent id); the position is the only
                // stable-enough key for this short-lived, order-only list.
                // biome-ignore lint/suspicious/noArrayIndexKey: see comment above.
                key={i}
                type="button"
                disabled={r.requestId == null}
                style={smallButton}
                onClick={() => {
                  if (r.requestId == null) return;
                  setRequestId(r.requestId);
                  void runExplain(r.requestId);
                }}
              >
                {r.status} {r.path}
                {r.requestId != null ? ` · ${r.requestId.slice(0, 12)}` : ""}
              </button>
            ))}
          </div>
        </div>
      )}
      {loading && <Empty text={t.loading} />}
      {error != null && <ErrorBanner text={t.fetchFailed(error)} role="alert" />}
      {report != null && (
        <>
          <div role="tablist" style={{ display: "flex", gap: 4, borderBottom: `1px solid ${V.border}` }}>
            {panels.map((p) => (
              <button
                key={p.key}
                type="button"
                role="tab"
                aria-selected={panel === p.key}
                onClick={() => setPanel(p.key)}
                style={{
                  ...smallButton,
                  border: "none",
                  borderBottom: panel === p.key ? `2px solid ${V.primary}` : "2px solid transparent",
                  borderRadius: 0,
                  fontWeight: panel === p.key ? 700 : 400,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {report.composes.length === 0 && panel !== "lineage" && panel !== "specTree" && (
              <Empty text={t.notFound} />
            )}
            {panel === "provenance" && <ProvenancePanel composes={report.composes} messages={t} />}
            {panel === "cacheKey" && <CacheKeyPanel composes={report.composes} messages={t} />}
            {panel === "decision" && <DecisionPanel composes={report.composes} messages={t} />}
            {panel === "scopes" && <ScopesPanel scopes={report.scopes} messages={t} />}
            {panel === "lineage" && <LineagePanel events={report.events} messages={t} />}
            {panel === "specTree" && <SpecTreePanel spec={spec} messages={t} />}
          </div>
        </>
      )}
    </div>
  );
}
