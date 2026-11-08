---
"@kohaku-ui/registry": patch
---

Python port (`kohaku-ui` on PyPI): `ComponentDefinition` gains `migrate_props` (the counterpart of TypeScript's `migrateProps`), and `host_core.plan_catalog_migration` now reshapes a deprecated node's props with it before revalidating against the replacement's schema. Previously the Python planner rewrote only `type` / `version`, so a rewrite that needed its props reshaped always landed in `blocked`. A core part's hook is hand-ported into `kohaku.registry.core._MIGRATE_PROPS` (empty today: no core part declares `migrateProps`); `export-core-catalog` now emits a `hasMigrateProps: true` marker so a missing or stale port fails when the Python core catalog loads. The TypeScript `@kohaku-ui/registry` has no behavior change beyond that marker (never emitted today) and is listed only because a changeset must name an npm package, and the fixed group moves npm and PyPI to the same version. See `python/README.md`.
