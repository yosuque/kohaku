import { lazy, type ReactNode, Suspense, useState } from "react";
import { useT } from "../i18n/ui.js";
import { client, devToolsCapture } from "./client.js";

/**
 * Kohaku DevTools ("why did this view come out this way") is dev-only tooling, same as AdminPage.tsx's
 * Gallery tab -- its dynamic import sits behind a literal `if (import.meta.env.DEV)` (not only a runtime
 * check inside JSX) so Vite's build-time replacement of `import.meta.env.DEV` with the literal `false`, plus
 * Rollup's dead-code elimination, drops the whole branch -- including the import() call -- before it ever
 * becomes a reachable module. A production build never bundles `@kohaku-ui/admin-react/devtools` at all.
 * Verify with `pnpm --filter @kohaku-ui-sample/web build` and grep the `dist/` output for "KohakuDevTools".
 */
let LazyKohakuDevTools: ReturnType<typeof lazy> | null = null;
if (import.meta.env.DEV) {
  LazyKohakuDevTools = lazy(() =>
    import("@kohaku-ui/admin-react/devtools").then((m) => ({ default: m.KohakuDevTools })),
  );
}

/**
 * A floating panel toggled by a small "DevTools" button, fixed at the bottom-right corner. Renders nothing
 * outside dev builds (LazyKohakuDevTools stays null). Shares the app's own `client` singleton (kohaku/client.ts)
 * so its "recent requests" quick-pick reflects every compose/events/etc. call this app itself makes.
 */
export function DevToolsMount(): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (LazyKohakuDevTools == null) return null;
  const DevTools = LazyKohakuDevTools;

  return (
    <div style={{ position: "fixed", bottom: 16, right: 16, zIndex: 100 }}>
      {open ? (
        <div
          style={{
            width: 440,
            maxHeight: "75vh",
            overflow: "auto",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
            borderRadius: 12,
          }}
        >
          <Suspense fallback={null}>
            <DevTools enabled client={client} capture={devToolsCapture} messages={t.devtools} />
          </Suspense>
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{
              marginTop: 8,
              width: "100%",
              border: "1px solid var(--app-border, #e5e7eb)",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 12,
              cursor: "pointer",
              background: "var(--app-elevated, #fff)",
            }}
          >
            {t.devtools.title} ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            border: "1px solid var(--app-border, #e5e7eb)",
            borderRadius: 999,
            padding: "8px 14px",
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
            background: "var(--app-elevated, #fff)",
            boxShadow: "0 2px 8px rgba(0, 0, 0, 0.15)",
          }}
        >
          🛠 {t.devtools.title}
        </button>
      )}
    </div>
  );
}
