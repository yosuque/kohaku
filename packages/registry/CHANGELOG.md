# @kohaku-ui/registry

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
