---
"@kohaku-ui/host-rest": patch
"@kohaku-ui/composer": patch
"@kohaku-ui/host-a2ui": patch
"@kohaku-ui/renderer-wc": patch
---

Bound client-supplied lineage strings (`surface`/`renderer`/`locale` to 64 chars, `specHash`/`artifactId` to 128) in host-rest's request schemas; verify a fixation's `intentHash`/`structureHash` against its own `pinnedSpec` before delivery in composer's `materializeFixation`; resolve `host-a2ui`'s per-ref data model concurrently instead of one ref at a time; and stop `<kohaku-surface>` from rebuilding its whole tree when only `onEvent`/`onNodeError`/`onActionResult` changes, plus repair properties assigned before the element was upgraded (the standard Custom Elements pattern).
