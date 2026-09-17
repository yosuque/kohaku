# @kohaku-ui/host-rest

## 0.2.0

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`0bea3f0`](https://github.com/yosuque/kohaku/commit/0bea3f047c496e08be629077bdd2018db153dd75) Thanks [@yosuque](https://github.com/yosuque)! - Fix `/lineage` and `/analytics/summary`'s `limit` query parsing, and the LLM retry adapter's `Retry-After` header parsing, to accept only whole decimal-digit strings (rejecting hex, scientific notation, numeric separators, and trailing garbage that a bare `Number`/`parseFloat` would otherwise silently misparse) — closing a TS/Python cross-language divergence on these inputs.

- [#9](https://github.com/yosuque/kohaku/pull/9) [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe) Thanks [@yosuque](https://github.com/yosuque)! - Bound client-supplied lineage strings (`surface`/`renderer`/`locale` to 64 chars, `specHash`/`artifactId` to 128) in host-rest's request schemas; verify a fixation's `intentHash`/`structureHash` against its own `pinnedSpec` before delivery in composer's `materializeFixation`; resolve `host-a2ui`'s per-ref data model concurrently instead of one ref at a time; and stop `<kohaku-surface>` from rebuilding its whole tree when only `onEvent`/`onNodeError`/`onActionResult` changes, plus repair properties assigned before the element was upgraded (the standard Custom Elements pattern).
- Updated dependencies [[`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/data-binding@0.2.0
  - @kohaku-ui/host-core@0.2.0
  - @kohaku-ui/registry@0.2.0
  - @kohaku-ui/spec-core@0.2.0
