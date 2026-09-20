---
"@kohaku-ui/composer": minor
"@kohaku-ui/renderer-core": minor
"@kohaku-ui/sandbox": minor
"@kohaku-ui/renderer-wc": minor
---

Design kit for L2 free generation: `DesignSystemGuide.kit` (built-in `DEFAULT_KIT_VOCABULARY`) presents component classes (`k-card`, `k-kpi`, `k-table`, …) and a token-driven utility subset to the model and enables the `L2_UNKNOWN_CLASS` lint; `mountSandbox` / `SandboxFrame` / `<kohaku-surface>` inject renderer-core's `defaultDesignKit.css` by default (`kitCss: ""` opts out, any other string is your own kit). The L2 system prompt now carries a design brief. Also, `collectL2Issues` and `collectUnknownKitClasses` are now exported from `@kohaku-ui/composer`'s root barrel (`collectL2Issues` was previously internal).

This CSS injection is not keyed by prompt revision, so it applies to every L2 artifact the host renders — not only new generations — including artifacts already in the compose cache, already fixated, and already promoted into a catalog. Concretely, previously generated HTML now picks up `*,*::before,*::after{box-sizing:border-box}`, `html,body{margin:0;padding:0}`, the `body` rule setting font family/size/line-height/colour/background (an artifact that set only `color` and relied on the browser's white background now sits on the theme background instead, e.g. going dark in dark mode), the `h1`–`h4` heading scale, and the `:focus-visible` ring. `kitCss: ""` on the surface (`mountSandbox` / `SandboxFrame` / `<kohaku-surface>`) is the per-surface opt-out; re-reviewing promoted L2 catalog entries after upgrading is advisable.
