# @kohaku-ui/sandbox

## 0.2.0

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`cb9f653`](https://github.com/yosuque/kohaku/commit/cb9f6538511151dd59980cc5e98c19d16f3f099d) Thanks [@yosuque](https://github.com/yosuque)! - Fix `maxDomNodes` to bound currently-connected DOM nodes instead of the lifetime count of nodes ever created (so removing nodes frees budget for new ones instead of eventually stalling a long-lived widget), and escape generated CSS so it cannot close the trusted `<style>` element it is embedded in.
- Updated dependencies [[`0e47898`](https://github.com/yosuque/kohaku/commit/0e478989d5f34980498d27cc95dfae40f8f4868b)]:
  - @kohaku-ui/renderer-core@0.2.0
  - @kohaku-ui/spec-core@0.2.0
