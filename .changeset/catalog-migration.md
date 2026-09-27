---
"@kohaku-ui/registry": minor
"@kohaku-ui/lineage": minor
"@kohaku-ui/host-core": minor
"@kohaku-ui/host-rest": minor
"@kohaku-ui/client": minor
"@kohaku-ui/cli": minor
"@kohaku-ui/admin-react": minor
---

Add catalog migration: deprecate a part, roll out a replacement gradually, and bulk-rewrite the fixations
still pinned on the old one (see `docs/design.md` decision #65).

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
