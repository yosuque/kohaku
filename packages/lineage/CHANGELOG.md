# @kohaku-ui/lineage

## 0.2.0

### Patch Changes

- [#9](https://github.com/yosuque/kohaku/pull/9) [`c283023`](https://github.com/yosuque/kohaku/commit/c283023c84f9544ead776d891c0ac1a790d8baa1) Thanks [@yosuque](https://github.com/yosuque)! - Fix `Promotions.reconcile()` to re-check each candidate's freshest status right after loading it, so a promotion transition that races the scan (e.g. a tenant-scoped withdraw or re-publish landing between the scan and the load) can no longer make reconcile re-publish a withdrawn candidate or unpublish a re-published one. Also skip non-projection statuses (everything but `published`/`withdrawn`) before loading them, inject the usage and generated-event indexes into `reconcile`/`listByStatus` to avoid an N+1 storage scan, and key nominate's idempotency guard by tenant while making its audit record fail-open like publish/unpublish already are.
- Updated dependencies []:
  - @kohaku-ui/spec-core@0.2.0
