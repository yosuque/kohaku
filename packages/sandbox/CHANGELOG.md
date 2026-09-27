# @kohaku-ui/sandbox

## 0.3.0

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/renderer-core@0.3.0

## 0.2.0

### Minor Changes

- [#23](https://github.com/yosuque/kohaku/pull/23) [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3) Thanks [@yosuque](https://github.com/yosuque)! - `provenance.generatorVersion` / `provenance.kit` (both MAY, spec/SPEC.md §2.1 Appendix item 13):
  the composer now stamps the Spec's `provenance` with the generator identity (`ComposePolicy.generatorVersion`)
  and design kit (`designSystem.kit`'s `{id, version}`) in effect at composition time, whenever either is
  set — on every tier, and preserved unchanged through a cache hit or an L1→L0 fixation.
  
  `mountSandbox`'s `kitCss?: string` option is now `@deprecated` (kept, unchanged, backward compatible) in
  favor of `kit?: DesignKitStylesheet | string | ((node, spec) => DesignKitStylesheet | string | undefined)`.
  A versioned `DesignKitStylesheet` (`{id, version, css}`) is compared against the Spec's own
  `provenance.kit` and a mismatch is reported via `bridge.onTelemetry({kind: "kit-mismatch"})` — fail-open,
  never blocking rendering (**SPEC-KIT-001**, SHOULD). This closes the gap where a design kit's CSS and
  vocabulary version had no verification mechanism (a vocabulary bump with no matching CSS change, or vice
  versa, previously rendered unstyled markup with no signal).
  
  `kit`'s resolver form, called with the frame's own `node`/`spec`, is available on both `SandboxFrame`
  (React) and `<kohaku-surface>`'s `context.sandbox.kit` (WC, closing the prior React/WC asymmetry). A host
  can read `spec.provenance.kit` inside it to serve each artifact the stylesheet it was actually composed
  against, rather than one stylesheet for the whole surface — replacing `kitCss: ""`'s all-or-nothing
  rollback (previously, silencing a regression in newly generated artifacts by clearing `kitCss` also
  stripped styling from every already-generated artifact under the old kit).
  
  Fully additive: existing `kitCss` callers, and Specs whose provenance carries neither field, are
  unaffected. `PROMPT_REVISION` and `policyFingerprint` are untouched by this change.

- [#23](https://github.com/yosuque/kohaku/pull/23) [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11) Thanks [@yosuque](https://github.com/yosuque)! - Design kit for L2 free generation: `DesignSystemGuide.kit` (built-in `DEFAULT_KIT_VOCABULARY`) presents component classes (`k-card`, `k-kpi`, `k-table`, …) and a token-driven utility subset to the model and enables the `L2_UNKNOWN_CLASS` lint; `mountSandbox` / `SandboxFrame` / `<kohaku-surface>` inject renderer-core's `defaultDesignKit.css` by default (`kitCss: ""` opts out, any other string is your own kit). The L2 system prompt now carries a design brief. Also, `collectL2Issues` and `collectUnknownKitClasses` are now exported from `@kohaku-ui/composer`'s root barrel (`collectL2Issues` was previously internal).
  
  This CSS injection is still not keyed by prompt revision or by the compose cache key, so it still applies to every L2 artifact the host renders — not only new generations — including artifacts already in the compose cache, already fixated, and already promoted into a catalog. Concretely, previously generated HTML now picks up `*,*::before,*::after{box-sizing:border-box}`, `html,body{margin:0;padding:0}`, the `body` rule setting font family/size/line-height/colour/background (an artifact that set only `color` and relied on the browser's white background now sits on the theme background instead, e.g. going dark in dark mode), the `h1`–`h4` heading scale, and the `:focus-visible` ring. An empty CSS string (`kit: ""` / `kitCss: ""` — the `SandboxFrame` prop, `mountSandbox`'s option, or `<kohaku-surface>`'s `context.sandbox.kit`) is still the per-surface opt-out; re-reviewing promoted L2 catalog entries after upgrading is advisable.
  
  A separate follow-up narrows this limitation without removing it: `mountSandbox`'s `kit` option now also accepts a versioned `DesignKitStylesheet` (`{id, version, css}`, superseding the now-`@deprecated` `kitCss` string) and a per-node resolver `(node, spec) => …`. The composer stamps the kit and generator identity it composed with onto every delivered Spec (`provenance.generatorVersion` / `provenance.kit`, both MAY — spec/SPEC.md §2.1 Appendix item 13), preserved unchanged through a cache hit or a fixation, and a versioned `kit` is compared against it (`bridge.onTelemetry({kind: "kit-mismatch"})`, fail-open — SPEC-KIT-001). A resolver reading `spec.provenance.kit` can then serve each artifact the CSS it was actually written against instead of one CSS for the whole surface — the fix for the all-or-nothing rollback this note originally described (`kitCss: ""` silencing a new artifact's regression by also stripping styling from every already-generated one). See docs/user-guide.md's design-kit section ("Detecting a stale kit" / "Rolling a kit change back per artifact").

- [#23](https://github.com/yosuque/kohaku/pull/23) [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39) Thanks [@yosuque](https://github.com/yosuque)! - Built-in parts read the non-color tokens (radius / space / font sizes / shadows) instead of literal px, the KPI renders as a card, tables get a muted header with 1px dividers, and hover / active / focus-visible states come from a theme-neutral stylesheet injected once per document (React) / shadow root (WC) — `PARTS_STATE_CSS` is injected unconditionally in this release, with no opt-out. The L2 sandbox chrome is tokenized and `badge="hidden"` removes the badge. Dialogs and toasts render with a stronger elevation, since `shadow.md`'s default was raised. Pre-existing presenter style functions gained an optional trailing `sizing` argument (default = the light theme's sizing); the new helpers (`metric*Style`, `dataStateNoticeStyle`, `gapFor`, `text-style.ts`, `misc-style.ts`) take `sizing` as a required parameter. New exports: `useSizing` (renderer-react) and `DEFAULT_SIZING` (renderer-core). `FORM_ROOT_STYLE` / `FIELD_ROW_STYLE` / `GAP` are deprecated in favour of `formRootStyle` / `fieldRowStyle` / `gapFor`.

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`cb9f653`](https://github.com/yosuque/kohaku/commit/cb9f6538511151dd59980cc5e98c19d16f3f099d) Thanks [@yosuque](https://github.com/yosuque)! - Fix `maxDomNodes` to bound currently-connected DOM nodes instead of the lifetime count of nodes ever created (so removing nodes frees budget for new ones instead of eventually stalling a long-lived widget), and escape generated CSS so it cannot close the trusted `<style>` element it is embedded in.
- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39), [`0e47898`](https://github.com/yosuque/kohaku/commit/0e478989d5f34980498d27cc95dfae40f8f4868b), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/renderer-core@0.2.0
