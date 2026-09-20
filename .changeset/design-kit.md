---
"@kohaku-ui/composer": minor
"@kohaku-ui/renderer-core": minor
"@kohaku-ui/sandbox": minor
"@kohaku-ui/renderer-wc": minor
---

Design kit for L2 free generation: `DesignSystemGuide.kit` (built-in `DEFAULT_KIT_VOCABULARY`) presents component classes (`k-card`, `k-kpi`, `k-table`, …) and a token-driven utility subset to the model and enables the `L2_UNKNOWN_CLASS` lint; `mountSandbox` / `SandboxFrame` / `<kohaku-surface>` inject renderer-core's `defaultDesignKit.css` by default (`kitCss: ""` opts out, any other string is your own kit). The L2 system prompt now carries a design brief. Also, `collectL2Issues` and `collectUnknownKitClasses` are now exported from `@kohaku-ui/composer`'s root barrel (`collectL2Issues` was previously internal).
