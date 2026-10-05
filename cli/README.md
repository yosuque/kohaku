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
test) that depends only on the published `@kohaku-ui/*` packages, then runs `npm install`. It
also writes a `.env` with a freshly generated capability secret, so add only a provider key to it
— never copy `.env.example` over it. See
`--out`, `--source`, `--name`, `--table` and `--no-install` in `--help`, and the
[Zero-Port quickstart](https://github.com/yosuque/kohaku/blob/main/docs/user-guide.md#zero-port-quickstart-from-your-own-data-no-port-code)
in the user guide for what it produces.

`usage export` derives per-day, per-tenant usage (compositions, cache outcomes, tiers, L2
generations, fallbacks, LLM tokens, fixations) from the **whole** lineage log in a window, for
metering or cost review. It pages the log exhaustively, unlike the bounded sample behind the admin
Analytics tab (`GET /analytics/summary`).

```bash
npx @kohaku-ui/cli usage export --data-dir ./.data --since 2026-09-01 --until 2026-09-30 --out usage.csv
npx @kohaku-ui/cli usage export --rest http://localhost:8787/api/kohaku \
  --header "x-kohaku-tenant:acme" --since 2026-09-01 --until 2026-09-30 --format json
```

`--data-dir` reads a local StoragePort directory (every tenant, unless `--tenant` narrows it);
`--rest` reads over REST and only sees the tenant of the session, so export each tenant with its
own `x-kohaku-tenant` header. A date-only `--until` includes that whole UTC day. The CSV has the
fixed header `day,tenant,composed,cache_hit,cache_miss,cache_bypass,cache_fixated,l0,l1,l2,l2_generated,fallbacks,tokens_in,tokens_out,fixated,unfixated`
(an unrecorded tenant is an empty field); `--format json` writes the same rows as an array.
Without `--out` the result goes to stdout. A bad window or format exits 2.

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/cli

Licensed under the Apache License, Version 2.0.
