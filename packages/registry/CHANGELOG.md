# @kohaku-ui/registry

## 0.7.0

### Minor Changes

- [#138](https://github.com/yosuque/kohaku/pull/138) [`2f5fa15`](https://github.com/yosuque/kohaku/commit/2f5fa156e84262d3380d5fda9cfce133382e8589) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum runtimes: Node from 24.22.1 to **26.12.1** and Python (the `kohaku-ui` distribution) from 3.12 to **3.13**. Every published package's `engines.node` is now `>=26.12.1`, and so is the `package.json` that `kohaku init` generates; `kohaku-ui` now declares `requires-python = ">=3.13"`. CI now verifies exactly one version of each runtime, and the declared floor is that version (CONTRIBUTING.md §2), so Node 24 and Python 3.12 are no longer tested. Projects still on Node 24 or Python 3.12 should upgrade before taking this release.

### Patch Changes

- Updated dependencies [[`2f5fa15`](https://github.com/yosuque/kohaku/commit/2f5fa156e84262d3380d5fda9cfce133382e8589)]:
  - @kohaku-ui/spec-core@0.7.0

## 0.6.0

### Patch Changes

- [#132](https://github.com/yosuque/kohaku/pull/132) [`05f2c6d`](https://github.com/yosuque/kohaku/commit/05f2c6d6f51a86e237a285a8e83e353571733a92) Thanks [@yosuque](https://github.com/yosuque)! - `planCatalogMigration` now passes a private deep copy of a node's props to a component's `migrateProps` hook (`structuredClone`). The memory and file storage ports return live records, so a hook that mutated its argument used to rewrite the stored fixation during planning, even when the plan ended up blocked or the hook threw. The hook contract (`ComponentDefinition.migrateProps`) now states that it must not mutate its argument and returns the new props. Python mirror: `migrate_props` receives `copy.deepcopy(node.props)`.

- [#117](https://github.com/yosuque/kohaku/pull/117) [`e4ae97d`](https://github.com/yosuque/kohaku/commit/e4ae97d43bc90c75370da22ec5f13ed83ce22a0a) Thanks [@yosuque](https://github.com/yosuque)! - Python port (`kohaku-ui` on PyPI): `ComponentDefinition` gains `migrate_props` (the counterpart of TypeScript's `migrateProps`), and `host_core.plan_catalog_migration` now reshapes a deprecated node's props with it before revalidating against the replacement's schema. Previously the Python planner rewrote only `type` / `version`, so a rewrite that needed its props reshaped always landed in `blocked`. A core part's hook is hand-ported into `kohaku.registry.core._MIGRATE_PROPS` (empty today: no core part declares `migrateProps`); `export-core-catalog` now emits a `hasMigrateProps: true` marker so a missing or stale port fails when the Python core catalog loads. The TypeScript `@kohaku-ui/registry` has no behavior change beyond that marker (never emitted today) and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.
- Updated dependencies [[`a6d485e`](https://github.com/yosuque/kohaku/commit/a6d485ef80f441f12ff6340748c8965bb6e578d2), [`0aad4eb`](https://github.com/yosuque/kohaku/commit/0aad4ebd9645542e65da006fabc6fb7cbf850bee), [`0d7d372`](https://github.com/yosuque/kohaku/commit/0d7d372a05ab7307d455dd0020fecd25e028fc9f), [`ad4ee22`](https://github.com/yosuque/kohaku/commit/ad4ee22db5d73dcaee0527dc037740325504be85), [`8d50be6`](https://github.com/yosuque/kohaku/commit/8d50be647b2cc19d7fce639803c31169f4a6a49d), [`687d437`](https://github.com/yosuque/kohaku/commit/687d437df3117305fc9c69bc33142ff1ad4ff55a)]:
  - @kohaku-ui/spec-core@0.6.0

## 0.5.0

### Minor Changes

- [#90](https://github.com/yosuque/kohaku/pull/90) [`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83) Thanks [@yosuque](https://github.com/yosuque)! - Raise the minimum Node version from 22 to 24.22.1: every published package's `engines.node` is now `>=24.22.1`, and so is the `package.json` that `kohaku init` generates. Node 22 is no longer tested in CI (the matrix is now Node 24 and 26), so the declared floor follows what is actually verified. Projects still on Node 22 should upgrade Node before taking this release.

### Patch Changes

- Updated dependencies [[`ec72334`](https://github.com/yosuque/kohaku/commit/ec723342ee08ec94982950caf0584b79fbd23b83), [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`b336fcb`](https://github.com/yosuque/kohaku/commit/b336fcbcefb08f8eb8240f5a61cf45db4a43721e)]:
  - @kohaku-ui/spec-core@0.5.0

## 0.4.1

### Patch Changes

- [#78](https://github.com/yosuque/kohaku/pull/78) [`a80f17a`](https://github.com/yosuque/kohaku/commit/a80f17a8ac304def877d23df9e7b8e37ef5c7396) Thanks [@yosuque](https://github.com/yosuque)! - The core `action.button` description (the text shown to the model and published in the catalog) now says that a write Action's name travels in the `action` key of the event payload, and that the component has no `action` prop (`presentForm` uses `props.action`). The props schema and the catalog fingerprint are unchanged.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`343ccd7`](https://github.com/yosuque/kohaku/commit/343ccd7a71d4370473640dce94f1e2e2a821b39d) Thanks [@yosuque](https://github.com/yosuque)! - `negotiate` no longer overwrites an existing `generation` fallback (or one without a `kind`) with its own `negotiation` trace. The downgrades are still applied and returned, but a generation-exhausted Spec keeps its deterministic-output marker, so it stays undisclosed as AI-generated content (design.md decision 66).
- Updated dependencies [[`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc)]:
  - @kohaku-ui/spec-core@0.4.1

## 0.4.0

### Minor Changes

- [#58](https://github.com/yosuque/kohaku/pull/58) [`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f) Thanks [@yosuque](https://github.com/yosuque)! - Add catalog migration: deprecate a part, roll out a replacement gradually, and bulk-rewrite the fixations
  still pinned on the old one (see `docs/design.md` decision [#65](https://github.com/yosuque/kohaku/issues/65)).
  
  - `@kohaku-ui/registry`: `ComponentDefinition` gains `deprecated?` (`{reason, since?, replacedBy?: {type,
    version?}, sunset?}`) and a TS-only `migrateProps?(props)` hook next to `fallback`. `resolveCatalog`
    validates that every `replacedBy` resolves in the merged catalog. A deprecated part drops out of the L1
    generation vocabulary but keeps validating Specs that already reference it, and the catalog fingerprint
    folds in a `!deprecated` suffix per such entry (every other entry's fingerprint contribution is
    unaffected). New `stagedCatalogFor({ stable, next, inRollout })` builds a `catalogFor`-shaped function for
    canary-rolling a migrated catalog in per tenant (tenant-neutral traffic always gets `stable`).
  - `@kohaku-ui/lineage`: `FIXATION_EVENT_TYPES` gains `intent.migrated`, recorded by a new
    `Fixations.replace(intentHash, pinnedSpec, { approver, guard, planId })` that rewrites a fixation's
    pinned structure in place (TOCTOU-guarded on the caller's observed revision/fixatedAt/structureHash/
    catalogFingerprint). `PromotionCandidate` also gains `origin` (kit/generatorVersion/model, read from
    `component.generated` and kept across every transition) — a promotion-review gap noted since U2.
  - `@kohaku-ui/host-core`: new `analyzeCatalogImpact` (broken fixations, deprecated-part usage, published
    promotions on a deprecated/removed part, origin-kit mismatches) and `planCatalogMigration` /
    `applyCatalogMigration` / `verifyCatalogMigrationPlan` (plan a bulk rewrite, revalidate it against the
    target catalog, then commit it through a host-supplied fixation-replace surface).
  - `@kohaku-ui/host-rest`: `GET /catalog` now serializes `deprecated` on each component (MAY, omitted when
    the part isn't deprecated).
  - `@kohaku-ui/client`: `SerializedComponentDef` / `CatalogResponse` gain `deprecated` /
    `SerializedDeprecation`; `PromotionCandidateView` gains `origin` / `PromotionOriginView`.
  - `@kohaku-ui/cli`: new `kohaku migrate plan --data-dir --catalog --out` (read-only) and `kohaku migrate
    apply --plan --approver --data-dir` (commits it; not safe to run concurrently with a live host sharing
    `--data-dir`).
  - `@kohaku-ui/admin-react`: the promotion card shows the candidate's generation kit/generatorVersion when
    known (`origin`, EN + JA copy).
  
  Fully additive: a catalog with no deprecated parts, a fixation store with no `intent.migrated` events, and a
  promotion record with no `origin` are all byte-identical to before this change.

### Patch Changes

- Updated dependencies [[`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0)]:
  - @kohaku-ui/spec-core@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e)]:
  - @kohaku-ui/spec-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [[`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353)]:
  - @kohaku-ui/spec-core@0.2.0
