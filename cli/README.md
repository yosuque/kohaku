# @kohaku-ui/cli

Command-line tools for kohaku: protocol conformance checks, scaffolding, project generation and
component validation.

Part of [kohaku](https://github.com/yosuque/kohaku), a reference implementation of the
[Kohaku Protocol](https://github.com/yosuque/kohaku/blob/main/spec/SPEC.md): UI treated as data
(a declarative UI Spec), with generation separated from rendering.

```bash
npx @kohaku-ui/cli conformance --self
npx @kohaku-ui/cli init --from sales.csv
```

`init` reads a `.csv` / `.json` (array of objects) / `.sqlite` file (SQLite needs Node >= 22.13),
infers which columns are categories, measures and a time axis, and generates a runnable project
(DomainPort, Intent catalog, an L0 fixed Spec, a Dashboard + Chat web app, a golden regression
test) that depends only on the published `@kohaku-ui/*` packages, then runs `npm install`. See
`--out`, `--source`, `--name`, `--table` and `--no-install` in `--help`, and the
[Zero-Port quickstart](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#zero-port-quickstart-from-your-own-data-no-port-code)
in the user guide for what it produces.

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/cli

Licensed under the Apache License, Version 2.0.
