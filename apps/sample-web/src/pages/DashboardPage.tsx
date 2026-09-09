import type { SurfaceEvent } from "@kohaku-ui/renderer-react";
import type { JsonObject } from "@kohaku-ui/spec-core";
import { type ReactNode, startTransition, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useT } from "../i18n/ui.js";
import { type ComposeView, composeGui, sendEvent } from "../kohaku/client.js";
import { ProvenanceBadge } from "../kohaku/ProvenanceBadge.js";
import { SpecJsonDrawer } from "../kohaku/SpecJsonDrawer.js";
import { SpecSurface } from "../kohaku/SpecSurface.js";
import { useLatestRequest } from "../kohaku/useLatestRequest.js";
import { ErrorBanner } from "./admin/ui.js";
import { FacetPanel } from "./FacetPanel.js";
import { DEFAULT_VIEW, parseFacetParams } from "./facet-views.js";

/**
 * The GUI surface. Facet operation → GuiAction → normalized Intent → compose → SpecSurface rendering.
 * Intent params are synced to the URL, which is what makes chat's "open in dashboard" link work.
 */
export function DashboardPage(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<ComposeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Completion notification of the write loop (action.invoke). Since emit does not reach onEvent (the part executes it directly),
  // onActionResult is wired to a page-level confirmation banner (the small loop = a demonstration with no Spec replacement).
  const [writeNotice, setWriteNotice] = useState<string | null>(null);
  // Shared across runCompose AND handleEvent (one sequence ref for the whole page): starting either one
  // supersedes an in-flight run of the other, same as the prior single `requestSeq` ref.
  const { loading, run } = useLatestRequest();
  const t = useT();

  // Demo toggle for SpecView's opt-in enableViewTransitions (see SpecView.tsx). Off by default so the
  // page's DOM behavior is unchanged unless a visitor opts in.
  const [viewTransitionsEnabled, setViewTransitionsEnabled] = useState(false);

  const intentName = searchParams.get("intent") ?? DEFAULT_VIEW.intent;
  const facetParams = parseFacetParams(searchParams);

  const onComposed = useCallback(
    (result: ComposeView) => {
      // A fresh compose result is exactly the "swap" SpecView's enableViewTransitions is meant to
      // animate (a new Intent = drill-down / facet change, or an L0→L1 tier flip on the same Intent).
      // Wrapping setView in startTransition is what actually lets the View Transition play — a plain
      // synchronous setState is React's own opt-out (see SpecView.tsx's enableViewTransitions doc
      // comment) — so only do this when the toggle is on.
      if (viewTransitionsEnabled) {
        startTransition(() => setView(result));
      } else {
        setView(result);
      }
      // Sync the normalized Intent (with defaults filled in) to the URL
      syncUrl(setSearchParams, result.spec.intent.canonical, result.spec.intent.params);
    },
    [setSearchParams, viewTransitionsEnabled],
  );
  const onComposeError = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );

  const runCompose = useCallback(
    (intent: string, params: JsonObject) =>
      run(() => composeGui({ intent, params }), {
        onStart: () => setError(null),
        onResult: onComposed,
        onError: onComposeError,
      }),
    [run, onComposed, onComposeError],
  );

  // Runs only on the first mount (deps []). Direct URL changes after mount (back/forward, etc.) are not picked up.
  useEffect(() => {
    void runCompose(intentName, facetParams);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEvent = useCallback(
    (event: SurfaceEvent): Promise<void> => {
      if (view == null) return Promise.resolve();
      return run(
        () =>
          sendEvent({
            intent: { canonical: view.spec.intent.canonical, params: view.spec.intent.params },
            on: event.on,
            payload: event.payload,
          }),
        { onStart: () => setError(null), onResult: onComposed, onError: onComposeError },
      );
    },
    [view, run, onComposed, onComposeError],
  );

  return (
    <div style={{ display: "flex", minHeight: "calc(100vh - 57px)" }}>
      <FacetPanel
        view={view?.spec.intent.canonical ?? intentName}
        params={view?.spec.intent.params ?? facetParams}
        onChange={(intent, params) => void runCompose(intent, params)}
      />
      <main style={{ flex: 1, padding: 24, display: "flex", flexDirection: "column", gap: 14 }}>
        {view != null && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <ProvenanceBadge spec={view.spec} />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {loading && (
                <span style={{ fontSize: 12, color: "var(--app-muted, #6b7280)" }}>
                  {t.dashboard.composing}
                </span>
              )}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--app-muted, #6b7280)",
                }}
              >
                <input
                  type="checkbox"
                  checked={viewTransitionsEnabled}
                  onChange={(e) => setViewTransitionsEnabled(e.target.checked)}
                />
                {t.dashboard.viewTransitionsToggle}
              </label>
            </div>
          </div>
        )}
        {error != null && <ErrorBanner text={error} />}
        {writeNotice != null && (
          <div
            style={{
              background: "#ecfdf5",
              color: "#065f46",
              borderRadius: 8,
              padding: "10px 14px",
              fontSize: 13,
            }}
          >
            {writeNotice}
          </div>
        )}
        {view != null ? (
          <>
            <div
              style={{
                background: "var(--app-elevated, #fff)",
                border: "1px solid var(--app-border, #e5e7eb)",
                borderRadius: 12,
                padding: 20,
              }}
            >
              <SpecSurface
                spec={view.spec}
                capability={view.capability}
                enableViewTransitions={viewTransitionsEnabled}
                onEvent={(e) => void handleEvent(e)}
                onActionResult={(r) => {
                  // Result of the direct write path. The Spec is not replaced; distant tables are re-resolved in-place via the invalidation bus.
                  if (r.phase === "failed") {
                    setWriteNotice(t.dashboard.writeFailed(r.action, r.message ?? "unknown error"));
                    return;
                  }
                  const res = r.result as { dataVersion?: string; notes?: number } | null;
                  setWriteNotice(
                    t.dashboard.writeCompleted(r.action, res?.dataVersion ?? "(updated)", res?.notes ?? null),
                  );
                }}
              />
            </div>
            <SpecJsonDrawer spec={view.spec} />
          </>
        ) : (
          !loading &&
          error == null && <div style={{ color: "var(--app-muted, #6b7280)" }}>{t.dashboard.loading}</div>
        )}
      </main>
    </div>
  );
}

function syncUrl(
  setSearchParams: (params: URLSearchParams, opts?: { replace?: boolean }) => void,
  intent: string,
  params: JsonObject,
): void {
  const next = new URLSearchParams();
  next.set("intent", intent);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) next.set(key, String(value));
  }
  setSearchParams(next, { replace: true });
}
