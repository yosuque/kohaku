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

`--data-dir` reads a local directory in the file layout of `createFileStoragePort` (every tenant,
unless `--tenant` narrows it; a Redis or Postgres deployment is read through `--rest` instead);
`--rest` reads over REST, where the `x-kohaku-tenant` header decides the tenant (export each tenant
with its own header; a host that sends no header, a legacy unscoped one, returns every tenant). A
date-only `--until` includes that whole UTC day. The CSV has the
fixed header `day,tenant,composed,cache_hit,cache_miss,cache_bypass,cache_fixated,l0,l1,l2,l2_generated,fallbacks,tokens_in,tokens_out,fixated,unfixated`
(an unrecorded tenant is an empty field; a tenant starting with `=`, `+`, `-` or `@` gets a leading
`'` so a spreadsheet does not read it as a formula); lines end in LF. `--format json` writes the
same rows as an array. Without `--out` the result goes to stdout.

Columns: `l2` counts the composes delivered as an L2 Spec (including ones served from the cache and
fallback Specs that kept the L2 label), `l2_generated` only those that actually generated an L2
Spec and succeeded (a fallback Spec of a failed or budget-skipped generation and a single-flight
follower are not counted; a negotiation downgrade of a Spec that was generated is, because its tokens
were spent), `cache_fixated` the composes served from a fixation, `fallbacks` the composes that carry a
fallback, and `fixated` / `unfixated` how many times a fixation was created / removed (operations,
not composes). A bad argument exits 2: a bad window or format, both or neither of `--data-dir` /
`--rest`, a `--data-dir` that does not exist, or a `--tenant` that disagrees with (or has no)
`x-kohaku-tenant` header.

The packages in this scope share a single version and are designed to be installed together.

- Documentation: https://github.com/yosuque/kohaku#readme
- Source: https://github.com/yosuque/kohaku/tree/main/cli

Licensed under the Apache License, Version 2.0.
