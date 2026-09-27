---
"@kohaku-ui/renderer-react": minor
"@kohaku-ui/renderer-wc": minor
---

Adds a typed way to register a product-specific part, so its `{type, version, propsSchema}` can live in one
`ComponentDefinition` instead of being re-typed as string literals at the registration call site (design.md
#68).

`@kohaku-ui/renderer-react`: `implement(def, Component)` wraps a component whose props are inferred from
`def.propsSchema` (`z.infer`) — no `node.props["x"] as T` cast needed — and returns an entry consumed by the
new `ImplRegistry.use(entry)`. The existing `register(type, version, component)` / `ImplProps` keep working
unchanged for parts that have no static `ComponentDefinition` (e.g. a promoted part's per-artifact schema).

`@kohaku-ui/renderer-wc`: `<kohaku-surface>` gains a public `registerPart(type, version, builder)` (it was
previously private with no way for a host to register anything beyond the core catalog), plus `getPartVersion`
for introspection, and `implementWc(def, builder)` is the typed counterpart of `implement` for a `PartBuilder`.

Both `implement` and `implementWc` validate a node's props against the schema by default outside a
`NODE_ENV=production` build, `console.warn` on a mismatch and render with the raw props (fail-open) rather
than failing the node; pass `{ validate }` to override either way.
