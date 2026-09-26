# @kohaku-ui/renderer-core

## 0.3.0

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/data-binding@0.3.0
  - @kohaku-ui/registry@0.3.0

## 0.2.0

### Minor Changes

- [#23](https://github.com/yosuque/kohaku/pull/23) [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11) Thanks [@yosuque](https://github.com/yosuque)! - Design kit for L2 free generation: `DesignSystemGuide.kit` (built-in `DEFAULT_KIT_VOCABULARY`) presents component classes (`k-card`, `k-kpi`, `k-table`, …) and a token-driven utility subset to the model and enables the `L2_UNKNOWN_CLASS` lint; `mountSandbox` / `SandboxFrame` / `<kohaku-surface>` inject renderer-core's `defaultDesignKit.css` by default (`kitCss: ""` opts out, any other string is your own kit). The L2 system prompt now carries a design brief. Also, `collectL2Issues` and `collectUnknownKitClasses` are now exported from `@kohaku-ui/composer`'s root barrel (`collectL2Issues` was previously internal).
  
  This CSS injection is still not keyed by prompt revision or by the compose cache key, so it still applies to every L2 artifact the host renders — not only new generations — including artifacts already in the compose cache, already fixated, and already promoted into a catalog. Concretely, previously generated HTML now picks up `*,*::before,*::after{box-sizing:border-box}`, `html,body{margin:0;padding:0}`, the `body` rule setting font family/size/line-height/colour/background (an artifact that set only `color` and relied on the browser's white background now sits on the theme background instead, e.g. going dark in dark mode), the `h1`–`h4` heading scale, and the `:focus-visible` ring. An empty CSS string (`kit: ""` / `kitCss: ""` — the `SandboxFrame` prop, `mountSandbox`'s option, or `<kohaku-surface>`'s `context.sandbox.kit`) is still the per-surface opt-out; re-reviewing promoted L2 catalog entries after upgrading is advisable.
  
  A separate follow-up narrows this limitation without removing it: `mountSandbox`'s `kit` option now also accepts a versioned `DesignKitStylesheet` (`{id, version, css}`, superseding the now-`@deprecated` `kitCss` string) and a per-node resolver `(node, spec) => …`. The composer stamps the kit and generator identity it composed with onto every delivered Spec (`provenance.generatorVersion` / `provenance.kit`, both MAY — spec/SPEC.md §2.1 Appendix item 13), preserved unchanged through a cache hit or a fixation, and a versioned `kit` is compared against it (`bridge.onTelemetry({kind: "kit-mismatch"})`, fail-open — SPEC-KIT-001). A resolver reading `spec.provenance.kit` can then serve each artifact the CSS it was actually written against instead of one CSS for the whole surface — the fix for the all-or-nothing rollback this note originally described (`kitCss: ""` silencing a new artifact's regression by also stripping styling from every already-generated one). See docs/user-guide.md's design-kit section ("Detecting a stale kit" / "Rolling a kit change back per artifact").

- [#23](https://github.com/yosuque/kohaku/pull/23) [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99) Thanks [@yosuque](https://github.com/yosuque)! - Extend the design-token vocabulary beyond colors: `font.family.*`, `font.size.*`, `space.*`, `radius.*`, `shadow.*` and `motion.*` (typed in `KnownThemeTokens`, defaulted in `defaultLightTheme` / `defaultDarkTheme`, resolvable via `resolveSizing`). The L2 design-system prompt now describes them (`PROMPT_REVISION` 12 — cached L2 generations are separated by prompt revision).

- [#23](https://github.com/yosuque/kohaku/pull/23) [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39) Thanks [@yosuque](https://github.com/yosuque)! - Built-in parts read the non-color tokens (radius / space / font sizes / shadows) instead of literal px, the KPI renders as a card, tables get a muted header with 1px dividers, and hover / active / focus-visible states come from a theme-neutral stylesheet injected once per document (React) / shadow root (WC) — `PARTS_STATE_CSS` is injected unconditionally in this release, with no opt-out. The L2 sandbox chrome is tokenized and `badge="hidden"` removes the badge. Dialogs and toasts render with a stronger elevation, since `shadow.md`'s default was raised. Pre-existing presenter style functions gained an optional trailing `sizing` argument (default = the light theme's sizing); the new helpers (`metric*Style`, `dataStateNoticeStyle`, `gapFor`, `text-style.ts`, `misc-style.ts`) take `sizing` as a required parameter. New exports: `useSizing` (renderer-react) and `DEFAULT_SIZING` (renderer-core). `FORM_ROOT_STYLE` / `FIELD_ROW_STYLE` / `GAP` are deprecated in favour of `formRootStyle` / `fieldRowStyle` / `gapFor`.

- [#23](https://github.com/yosuque/kohaku/pull/23) [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353) Thanks [@yosuque](https://github.com/yosuque)! - Follow-up to the non-color tokens work (`.changeset/l1-parts-tokens.md`): this release settles the two
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

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`0e47898`](https://github.com/yosuque/kohaku/commit/0e478989d5f34980498d27cc95dfae40f8f4868b) Thanks [@yosuque](https://github.com/yosuque)! - Implement `presentSpreadsheet`'s already-declared `sortChange` and `cellEdit` events and `editable` prop in both renderers: a user sort toggle can now emit `sortChange` (`{ value: { field, dir } }`), and `editable: true` turns idle cells into edit-trigger buttons that swap to a text input, coercing the typed value by column type and delivering a changed, valid edit via `cellEdit` (`{ row, value: { column, value, previousValue, rowIndex } }`) over the invoke path — with an optimistic local display that a fresh fetch discards automatically. Also cap `presentSpreadsheet`'s local (non-serverSide) row rendering at 500 rows and make the truncation footer honest when the source reports no `total`.
- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/data-binding@0.2.0
  - @kohaku-ui/registry@0.2.0
