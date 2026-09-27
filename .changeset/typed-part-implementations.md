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

Both `implement` and `implementWc` parse a node's props against the schema **unconditionally, in every
environment** (`propsSchema.safeParse` is also what materializes a `.default()`-ed prop the Spec omits, not
just a validation nicety, so it never skips in production) — on success the component receives the parsed
value, on failure it receives the raw (unvalidated) props instead (fail-open: a malformed prop degrades the
part's own display rather than the whole surface). Only the diagnostic — a `console.warn` on a mismatch — is
gated by environment: by default it fires outside a `NODE_ENV=production` build; pass `{ validate }` to force
the warning on or off regardless of environment.
