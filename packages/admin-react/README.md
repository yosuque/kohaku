# @kohaku-ui/admin-react

Governance console for kohaku hosts — the four review surfaces (View Lineage, Analytics, Promotion review L2→L1,
Fixation L1→L0) as embeddable React components. Talks to the host only through `@kohaku-ui/client`.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

Requires a host that wires `lineage` / `promotions` / `fixations` into `createKohakuRoutes` (see
[the user guide's §6 Step 2](../../docs/user-guide.md)); the `kohaku init` starter project does not do this
yet, so those routes 404 there until you add them.

```bash
npm install @kohaku-ui/admin-react @kohaku-ui/client react react-dom zod
```

```tsx
import { KohakuAdmin } from "@kohaku-ui/admin-react";
import { createKohakuClient } from "@kohaku-ui/client";

const client = createKohakuClient({
  baseUrl: "/api/kohaku",
  // tenant / role headers are the product's concern (e.g. from your auth layer)
  headers: () => ({ "x-kohaku-tenant": currentTenant() }),
});

export function AdminPage() {
  return <KohakuAdmin client={client} tenant={currentTenant()} />;
}
```

- `messages` — an `AdminMessages` object for i18n (`defaultAdminMessages` is English). Beyond the per-tab
  copy, it carries `deniedMessage` (403 role explanation), `authRequiredMessage` (401 — sign in again), and the
  Promotions tab's `evaluateButton` label ("Extract candidates" — the toolbar action that calls
  `promotion.evaluate`; the status filter itself, including "all", is always a read-only `promotion.list`).
- `theme` — renderer-core `ThemeTokens`; the console follows `--kohaku-color-*` (light fallbacks when omitted).
- `toolbar` / `extraTabs` — product-specific controls and tabs rendered inside the same provider.
- `promotionDefaults` — prefill / `queryTemplate.path` choices for the promotion approval form.

RBAC: `describeDeniedOperation` (exported from the root) turns a caught `KohakuHostError` into reviewer copy —
a 401 becomes `authRequiredMessage` ("sign in again"), a 403 `CAPABILITY_DENIED` becomes `deniedMessage`
(the role explanation, shown as a red banner); the RBAC policy itself lives on the host
(`createGovernancePolicy`). Every built-in tab already applies this; call it yourself only if you add a tab of
your own that talks to the host directly.

The package root exports only the domain API (`KohakuAdmin`, the hooks, the tabs, `AdminMessages`,
`describeDeniedOperation`, `TIER_COLOR`, and the `NoticeKind` / `NotifyFn` types used by `AdminProvider`'s
`onNotice`). The generic, common-word UI primitives the console's tabs are built from — `card`, `Field`,
`Empty`, `StatCard`, `StatusBadge`, `BarRow`, `ErrorBanner`, and the rest — live on a separate
`@kohaku-ui/admin-react/ui` subpath, so a consuming app that already has its own `Field` or `card` never has to
alias an import. Reach for `/ui` only if you're extending the console with your own tabs and want the same
primitives; ordinary `KohakuAdmin` usage never needs it — `describeDeniedOperation` / `TIER_COLOR` are domain
vocabulary, not presentation primitives, so they live at the root instead, not on `/ui`.
