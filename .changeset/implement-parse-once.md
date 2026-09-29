---
"@kohaku-ui/renderer-react": patch
"@kohaku-ui/renderer-wc": patch
---

`implement` and `implementWc` parse a node's props against the part's schema once per `node.props` object instead of on every render or rebuild, and emit the dev-mode schema-mismatch warning once per props object (design.md decision 68). Rendered output is unchanged.
