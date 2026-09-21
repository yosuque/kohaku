---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/renderer-core": minor
"@kohaku-ui/renderer-react": minor
---

Follow-up to the non-color tokens work (`.changeset/l1-parts-tokens.md`): this release settles the two
places that PR left inconsistent, breaking rather than shimming (0.x, per the deletion-side convention
this branch has already applied elsewhere).

`@kohaku-ui/renderer-core`:

- Removed the `@deprecated` `FORM_ROOT_STYLE` / `FIELD_ROW_STYLE` (`presenters/form.ts`) and `GAP`
  (`presenters/layout.ts`) constants (no in-repo callers). Use `formRootStyle(sizing)` /
  `fieldRowStyle(sizing)` / `gapFor(sizing, size)` instead — all three already existed alongside them.
- `sizing: SizingTokens` is now a **required** trailing parameter on the 15 presenter style functions
  that previously defaulted it to the light theme (`formRootStyle`, `fieldRowStyle`,
  `formControlBaseStyle`, `formSubmitButtonStyle`, `actionButtonStyle`, `tabButtonStyle`,
  `dialogTitleStyle`, `toastStyle`, `spreadsheetThStyle`, `spreadsheetSortButtonStyle`,
  `spreadsheetTdStyle`, `spreadsheetCellEditInputStyle`, `spreadsheetFooterBarStyle`,
  `spreadsheetFooterTotalStyle`, `spreadsheetPagerButtonStyle`), matching every other presenter style
  function, which already required it. `DEFAULT_SIZING` stays exported for external callers: pass it
  explicitly to reproduce the exact values a call with no `sizing` argument used to resolve.
- The L2 sandbox badge/notice chrome (`presenters/sandbox-chrome.ts`) and the overlay dialog
  (`presenters/overlay.ts`) no longer re-resolve non-color tokens from `theme` on every call.
  `sandboxBadgeRowStyle` / `sandboxBadgePillStyle` gain a required trailing `sizing: SizingTokens`
  parameter; `sandboxNoticeBaseStyle`'s signature changes from `(theme)` to `(sizing)` (it never read a
  color token, so `theme` is dropped rather than kept unused); `dialogBoxStyle` gains a required trailing
  `sizing` parameter (after `accentBorder`); `dialogCloseButtonStyle` / `dialogDescriptionStyle` gain a
  required trailing `sizing` parameter. `sandboxBadgeDescriptionStyle` and `sandboxNoticeToneStyle` are
  colors-only and are unchanged. Both renderers' own call sites (`@kohaku-ui/sandbox`'s `SandboxFrame`,
  renderer-wc's `sandbox-mount.ts` / `parts/overlay.ts`, renderer-react's `core/overlay.tsx`) already pass
  their once-per-render resolved `sizing` (`useSizing()` / `RenderRuntime.sizing`), so this is a pure
  signature change for them — no behavior change, no new resolution cost.
- `SizingTokens` is renamed to `NonColorTokens` (6 of its 22 fields — `fontSans`/`fontMono`,
  `shadowSm`/`shadowMd`, `motionDuration`/`motionEasing` — were never sizes, and the docs and this file's
  own comments already called the group "non-color tokens"). `SizingTokens` remains exported as a type
  alias (`export type SizingTokens = NonColorTokens`), so existing type annotations keep compiling
  unchanged. `resolveSizing` / `useSizing` / `RenderRuntime.sizing` keep their names (unifying that
  naming is a separate follow-up).

- `dialogOverlayStyle` / `dialogHeaderStyle` / `toastDismissButtonStyle` (`presenters/overlay.ts`) were the
  last plain `const` style objects in `overlay.ts` and are now functions, matching every other style export
  in the file: `dialogOverlayStyle(theme, sizing)`, `dialogHeaderStyle(sizing)`,
  `toastDismissButtonStyle(sizing)`. This also finishes tokenizing the file's remaining literals
  (`dialogOverlayStyle`'s padding, `dialogHeaderStyle`'s gap, `dialogBoxStyle`'s `calc()` max-height,
  `toastStyle`'s bottom offset, `toastDismissButtonStyle`'s font size) and `text-style.ts`'s
  `textListStyle`/`textCodeStyle` padding — both renderers' own call sites already resolve `theme`/`sizing`
  once per render, so this is a pure signature change for them.
- New token `color.scrim` (`@kohaku-ui/spec-core`'s `KnownThemeTokens`): the dialog backdrop color, now
  themeable instead of a hard-coded `rgba(17, 24, 39, 0.45)` (dark theme gets its own heavier value). Like
  `color.danger` / `color.focus` / `chart.palette`, it is excluded from the L2 generation vocabulary (the
  sandbox never renders a dialog), so this does not change `designSystemPromptFragment`'s output or
  `PROMPT_REVISION`.

`@kohaku-ui/renderer-react`:

- `RendererContextValue.renderSandbox` gains a 3rd parameter: `(node, spec, theme) => ReactNode`.
  `SpecView` now calls it with the provider's own `theme` (the same value `useRenderer().theme` /
  `useToken`/`useSizing` already read), so a host no longer needs to thread `theme` through its own
  closure to keep `SandboxFrame` in sync with the surface's theme — it can read the 3rd argument instead.
  Fully additive for an existing 2-argument implementation (still type-checks and runs unchanged, the
  extra argument is simply ignored); the sample app (`apps/sample-web`) and the React/WC parity harness
  have been migrated to the new argument, dropping their own manual `theme` closures.
