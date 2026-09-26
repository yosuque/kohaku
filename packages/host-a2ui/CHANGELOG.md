# @kohaku-ui/host-a2ui

## 0.3.0

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0

## 0.2.0

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe) Thanks [@yosuque](https://github.com/yosuque)! - Bound client-supplied lineage strings (`surface`/`renderer`/`locale` to 64 chars, `specHash`/`artifactId` to 128) in host-rest's request schemas; verify a fixation's `intentHash`/`structureHash` against its own `pinnedSpec` before delivery in composer's `materializeFixation`; resolve `host-a2ui`'s per-ref data model concurrently instead of one ref at a time; and stop `<kohaku-surface>` from rebuilding its whole tree when only `onEvent`/`onNodeError`/`onActionResult` changes, plus repair properties assigned before the element was upgraded (the standard Custom Elements pattern).
- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0
