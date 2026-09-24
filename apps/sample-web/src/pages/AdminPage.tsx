import { type AdminExtraTab, KohakuAdmin, useAdminNotice } from "@kohaku-ui/admin-react";
import { deniedMessage } from "@kohaku-ui/admin-react/ui";
import { isKohakuHostError } from "@kohaku-ui/client";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import { t as dict, useT } from "../i18n/ui.js";
import { bumpDataVersion, client } from "../kohaku/client.js";
import { useTenant } from "../kohaku/tenant.js";
import { useThemeMode } from "../theme/mode.js";
import { buildTheme } from "../theme/tokens.js";
import { salesPromotionDefaults } from "./admin/promotion-defaults.js";

/**
 * The Gallery tab (n-16) is dev/admin-only tooling — its hand-written showcase artifact
 * (gallery-showcase.ts) has no reason to reach production users. It is loaded via React.lazy, and the
 * dynamic import itself sits behind a literal `if (import.meta.env.DEV)` statement rather than only a
 * runtime check inside JSX: Vite replaces `import.meta.env.DEV` with the literal `false` at build time,
 * and Rollup's dead-code elimination then drops the whole `if` branch — including the import() call —
 * before it ever becomes a reachable module, so a production build never emits gallery-showcase.ts's
 * code at all (not even as a separate, unreferenced lazy chunk). Verify with
 * `pnpm --filter @kohaku-ui-sample/web build` and grep the `dist/` output for "gallery-showcase".
 */
let LazyGalleryTab: ReturnType<typeof lazy> | null = null;
if (import.meta.env.DEV) {
  LazyGalleryTab = lazy(() => import("./admin/GalleryTab.js").then((m) => ({ default: m.GalleryTab })));
}

/**
 * The governance surface, now the published `@kohaku-ui/admin-react` console. What stays in the sample is the
 * demo plumbing: the tenant / role headers ride on `client` (kohaku/client.ts), the tenant selection is the
 * remount key (role is deliberately not — see KohakuAdminProps' own doc comment), the theme follows the
 * header's light/dark toggle, the dictionary follows the EN/JA toggle, the sales-catalogue draft defaults
 * come from promotion-defaults.ts, and the "bump" control is a toolbar slot.
 */
export function AdminPage(): ReactNode {
  const [tenant] = useTenant();
  const t = useT();
  const { mode } = useThemeMode();
  const theme = useMemo(() => buildTheme(mode), [mode]);

  // Sample-only tabs beyond the four built-in ones. Add further product-specific tabs to this array.
  const extraTabs: AdminExtraTab[] = useMemo(
    () =>
      LazyGalleryTab != null
        ? [
            {
              key: "gallery",
              label: t.admin.tabGallery,
              render: () => {
                const Gallery = LazyGalleryTab!;
                return (
                  <Suspense fallback={<p>Loading…</p>}>
                    <Gallery />
                  </Suspense>
                );
              },
            },
          ]
        : [],
    [t.admin.tabGallery],
  );

  return (
    <KohakuAdmin
      client={client}
      tenant={tenant}
      theme={theme}
      messages={t.admin}
      promotionDefaults={salesPromotionDefaults}
      extraTabs={extraTabs}
      toolbar={<BumpButton />}
    />
  );
}

/**
 * Sample-only: advances the server's dataVersion so the next compose is a cache MISS (Demo 1). Now behind
 * identity + governance RBAC (admin.bumpDataVersion — admin only) and, under a JWT deployment, disabled unless
 * the server opts in (KOHAKU_DEMO_ADMIN_ROUTES=1) — see client.ts's bumpDataVersion doc comment — so a 403 or
 * 404 here is an expected outcome, surfaced as an error notice rather than an unhandled rejection.
 */
function BumpButton(): ReactNode {
  const t = useT();
  const notify = useAdminNotice();
  return (
    <button
      type="button"
      onClick={() => {
        // dict() (not the hook value) so the notification uses the language at completion time.
        void bumpDataVersion()
          .then((v) => notify(dict().admin.bumpNotice(v)))
          .catch((e: unknown) => {
            const messages = dict().admin;
            const denied = isKohakuHostError(e) ? deniedMessage(e, messages.opBump, messages) : null;
            notify(denied ?? messages.bumpFailed, "error");
          });
      }}
      style={{
        border: "1px solid var(--kohaku-color-warning-text, #854d0e)",
        background: "var(--kohaku-color-warning-surface, #fef9c3)",
        color: "var(--kohaku-color-warning-text, #854d0e)",
        borderRadius: 8,
        padding: "8px 14px",
        fontSize: 12.5,
        cursor: "pointer",
      }}
    >
      {t.admin.bumpButton}
    </button>
  );
}
