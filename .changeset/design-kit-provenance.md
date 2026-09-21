---
"@kohaku-ui/spec-core": minor
"@kohaku-ui/composer": minor
"@kohaku-ui/sandbox": minor
"@kohaku-ui/renderer-wc": minor
---

`provenance.generatorVersion` / `provenance.kit` (both MAY, spec/SPEC.md §2.1 Appendix item 13):
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
