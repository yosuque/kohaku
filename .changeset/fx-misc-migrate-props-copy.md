---
"@kohaku-ui/host-core": patch
"@kohaku-ui/registry": patch
---

`planCatalogMigration` now passes a private deep copy of a node's props to a component's `migrateProps` hook (`structuredClone`). The memory and file storage ports return live records, so a hook that mutated its argument used to rewrite the stored fixation during planning, even when the plan ended up blocked or the hook threw. The hook contract (`ComponentDefinition.migrateProps`) now states that it must not mutate its argument and returns the new props. Python mirror: `migrate_props` receives `copy.deepcopy(node.props)`.
