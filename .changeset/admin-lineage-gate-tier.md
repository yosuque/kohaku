---
"@kohaku-ui/admin-react": patch
---

The Lineage tab and the DevTools lineage panel show the composition tier (L0/L1/L2) only for `view.*` / `component.*` events, and render an `action.*` event's gate tier as `gate:<tier>` in its own color, so `L1` and `approve` no longer share one undifferentiated column. The wire payload is unchanged.
