# @kohaku-ui/otel

## 0.7.0

### Minor Changes

- [#138](https://github.com/yosuque/kohaku/pull/138) [`2f5fa15`](https://github.com/yosuque/kohaku/commit/2f5fa156e84262d3380d5fda9cfce133382e8589) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum runtimes: Node from 24.22.1 to **26.12.1** and Python (the `kohaku-ui` distribution) from 3.12 to **3.13**. Every published package's `engines.node` is now `>=26.12.1`, and so is the `package.json` that `kohaku init` generates; `kohaku-ui` now declares `requires-python = ">=3.13"`. CI now verifies exactly one version of each runtime, and the declared floor is that version (CONTRIBUTING.md §2), so Node 24 and Python 3.12 are no longer tested. Projects still on Node 24 or Python 3.12 should upgrade before taking this release.

### Patch Changes

- Updated dependencies [[`2f5fa15`](https://github.com/yosuque/kohaku/commit/2f5fa156e84262d3380d5fda9cfce133382e8589)]:
  - @kohaku-ui/composer@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [[`4e28451`](https://github.com/yosuque/kohaku/commit/4e284512c2db9a0e2ac0bd8ab118689fbebe5c10), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85)]:
  - @kohaku-ui/composer@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

### Patch Changes

- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e), [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141)]:
  - @kohaku-ui/composer@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`6b01a1f`](https://github.com/yosuque/kohaku/commit/6b01a1fe0e8ac5f640bbc0a482a3dbe43e6b353a)]:
  - @kohaku-ui/composer@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [[`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049)]:
  - @kohaku-ui/composer@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies []:
  - @kohaku-ui/composer@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe)]:
  - @kohaku-ui/composer@0.2.0
