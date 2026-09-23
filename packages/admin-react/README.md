# @kohaku-ui/admin-react

Governance console for kohaku hosts — the four review surfaces (View Lineage, Analytics, Promotion review L2→L1,
Fixation L1→L0) as embeddable React components. Talks to the host only through `@kohaku-ui/client`.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npm install @kohaku-ui/admin-react @kohaku-ui/client react react-dom
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

- `messages` — an `AdminMessages` object for i18n (`defaultAdminMessages` is English).
- `theme` — renderer-core `ThemeTokens`; the console follows `--kohaku-color-*` (light fallbacks when omitted).
- `toolbar` / `extraTabs` — product-specific controls and tabs rendered inside the same provider.
- `promotionDefaults` — prefill / `queryTemplate.path` choices for the promotion approval form.

RBAC: a 403 `CAPABILITY_DENIED` from any governance route is shown as a red banner explaining the operation the
current role is not allowed to perform; the policy itself lives on the host (`createGovernancePolicy`).

The package root exports only the domain API (`KohakuAdmin`, the hooks, the tabs, `AdminMessages`, and the
`NoticeKind` / `NotifyFn` types used by `AdminProvider`'s `onNotice`). The generic, common-word UI primitives the
console's tabs are built from — `card`, `Field`, `Empty`, `StatCard`, `StatusBadge`, `BarRow`, `ErrorBanner`, and
the rest — live on a separate `@kohaku-ui/admin-react/ui` subpath, so a consuming app that already has its own
`Field` or `card` never has to alias an import. Reach for `/ui` only if you're extending the console with your
own tabs and want the same primitives; ordinary `KohakuAdmin` usage never needs it.
