---
"@kohaku-ui/admin-react": minor
---

New package: the governance console (View Lineage / Analytics / Promotion review / Fixation) the sample's Admin page shipped with, now as embeddable React components. It talks to the host only through `@kohaku-ui/client` (inject a `KohakuClient`), takes an `AdminMessages` dictionary for i18n, follows renderer-core `ThemeTokens` via `--kohaku-color-*`, and keeps the sha256-identical promotion preview (direct sandbox mount). Product-specific pieces are slots: `toolbar`, `extraTabs`, `promotionDefaults`. Depends only on `client` + `renderer-core` + `sandbox` + `spec-core` (never `renderer-react` or `host-rest`); `apps/sample-web`'s Admin page is now a thin wrapper over it.
