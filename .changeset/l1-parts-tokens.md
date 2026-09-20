---
"@kohaku-ui/renderer-core": minor
"@kohaku-ui/renderer-react": minor
"@kohaku-ui/renderer-wc": minor
"@kohaku-ui/sandbox": minor
---

Built-in parts read the non-color tokens (radius / space / font sizes / shadows) instead of literal px, the KPI renders as a card, tables get a muted header with 1px dividers, and hover / active / focus-visible states come from a theme-neutral stylesheet injected once per document (React) / shadow root (WC) — `PARTS_STATE_CSS` is injected unconditionally in this release, with no opt-out. The L2 sandbox chrome is tokenized and `badge="hidden"` removes the badge. Dialogs and toasts render with a stronger elevation, since `shadow.md`'s default was raised. Pre-existing presenter style functions gained an optional trailing `sizing` argument (default = the light theme's sizing); the new helpers (`metric*Style`, `dataStateNoticeStyle`, `gapFor`, `text-style.ts`, `misc-style.ts`) take `sizing` as a required parameter. New exports: `useSizing` (renderer-react) and `DEFAULT_SIZING` (renderer-core). `FORM_ROOT_STYLE` / `FIELD_ROW_STYLE` / `GAP` are deprecated in favour of `formRootStyle` / `fieldRowStyle` / `gapFor`.
