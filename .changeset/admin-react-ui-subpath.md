---
"@kohaku-ui/admin-react": minor
---

The package root no longer exports the thirteen generic UI primitives (`card`, `Field`, `Empty`, `smallButton`, `StatCard`, `StatusBadge`, `BarRow`, `sectionTitle`, `selectStyle`, `TextAreaField`, `ErrorBanner`, `TIER_COLOR`, `deniedMessage`) alongside its domain API — they move to a new `@kohaku-ui/admin-react/ui` subpath. The root now carries only `KohakuAdmin`, the tabs, the hooks, `AdminMessages`/`defaultAdminMessages`, and the `NoticeKind`/`NotifyFn` types used by `AdminProvider`'s `onNotice` (those two stay on the root even though they're defined alongside the primitives). If your app imports any of the thirteen from the package root, switch that import to `@kohaku-ui/admin-react/ui`; every other import (`KohakuAdmin`, `AdminMessages`, etc.) is unaffected. This package has not been published yet, so this is a record of the change rather than a migration for existing consumers.
