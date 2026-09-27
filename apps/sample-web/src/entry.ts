/**
 * The "./app" export: the pieces an external host needs to embed this app's UI without forking it.
 * `App` itself already takes no Router prop and renders no `<BrowserRouter>` of its own (see `App.tsx`) —
 * it uses `<Routes>`/`<Route>`/`<NavLink>`, which work under any react-router-dom router — so the only thing
 * a host adds around it is its own Router choice (this package's own `main.tsx` wraps it in
 * `BrowserRouter`; the static playground, U5, wraps the same `App` in `HashRouter`, since a `BrowserRouter`
 * on GitHub Pages 404s on a deep-linked path with no server-side rewrite to fall back to `index.html`).
 *
 * Also re-exports the role/tenant module-level state (`role.ts`/`tenant.ts`): a host that wants to reset the
 * demo (the playground's Reset button) calls `setRole`/`setTenant` directly — the same functions the header
 * selectors themselves call — rather than trying to guess or duplicate their localStorage key.
 */
export { App } from "./App.js";
export { getRole, ROLES, type Role, roleHeader, setRole, useRole } from "./kohaku/role.js";
export { getTenant, setTenant, TENANTS, type Tenant, tenantHeader, useTenant } from "./kohaku/tenant.js";
export { ThemeModeProvider, useThemeMode } from "./theme/mode.js";

import "./theme/app-theme.css";
