---
"@kohaku-ui/lineage": patch
---

`promotions.listByStatus(status)` for a status other than `in_use` now narrows the persisted promotion states to that status first and returns an empty list straight away when none match, without reading the `component.used` or `component.generated` windows. A poll of an empty queue (the admin Promotions tab lists several statuses per refresh) no longer pays for those reads. The result and the wire are unchanged.
