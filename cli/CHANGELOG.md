# @kohaku-ui/cli

## 0.2.0

### Patch Changes

- [#18](https://github.com/yosuque/kohaku/pull/18) [`108b3b3`](https://github.com/yosuque/kohaku/commit/108b3b33465050592df72d35bed8cf9ab16d6711) Thanks [@yosuque](https://github.com/yosuque)! - Stop declaring `tsx` as a runtime dependency of the published CLI. The published `kohaku` bin runs the compiled `dist/index.js`, so `npx @kohaku-ui/cli` no longer downloads tsx/esbuild; the in-repo `bin/kohaku.js` launcher still resolves tsx from the workspace.
- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`b922703`](https://github.com/yosuque/kohaku/commit/b9227038c12dcaf790697b5ca8f1e70c98abc154), [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353), [`cb9f653`](https://github.com/yosuque/kohaku/commit/cb9f6538511151dd59980cc5e98c19d16f3f099d)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/sandbox@0.2.0
  - @kohaku-ui/evals@0.2.0
  - @kohaku-ui/spec@0.2.0
