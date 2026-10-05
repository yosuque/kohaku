# @kohaku-ui/cli

## 0.5.0

### Patch Changes

- [#81](https://github.com/yosuque/kohaku/pull/81) [`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d) Thanks [@yosuque](https://github.com/yosuque)! - Structural refactoring, round two (behavior-preserving):
  
  - `@kohaku-ui/host/mcp-http` (new subpath): `createMcpHttpServer`, the Streamable-HTTP scaffold (Host/Origin guards, echoed-Origin CORS, OPTIONS preflight, size-capped body pre-read, stateless `createMcpHandler` wiring) that `apps/sample-mcp` used to carry inline. `@modelcontextprotocol/node` becomes an optional peer dependency, needed only for this subpath. Defaults follow the server `kohaku init --mcp` generates; every place the sample answers differently is an explicit option. The init template itself still carries its own copy and switches after this release.
  - `@kohaku-ui/host-core`: `buildActionManifestSafely` and `recordComposedAndFallback`, the order-neutral delivery helpers both host profiles now call (each host keeps its own step order and `onError` endpoint names; characterization tests pin them).
  - `@kohaku-ui/spec-core`: `src/ports.ts` is now a barrel over one file per Port under `src/ports/` (plus `theme-tokens.ts`); every exported name and import path is unchanged.
  - `@kohaku-ui/host-rest`: the compose pipeline helpers (capability issuance, fixation host) live in `routes/compose-pipeline.ts`.
  - `@kohaku-ui/cli`: one registration module per command under `cli/src/cli/`, result printers next to their runners as `format*` functions; `--help` output and exit codes are unchanged (pinned by a help snapshot test).

- [#80](https://github.com/yosuque/kohaku/pull/80) [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141) Thanks [@yosuque](https://github.com/yosuque)! - Internal, behavior-preserving refactoring of the composer tier ladder (budget gate, discriminated `TierResult`, L2 lint rule table), the evals judge (pure verdict aggregation), lineage (promotion import cycle, fixation guard/stamp helpers, candidate bulk loader, analytics accumulators), the CLI (shared lineage-source options, scaffold target table), both hosts (compose pipeline module, shared tool-call preamble, inline gate mapping) and the Postgres/Redis adapters (shared WHERE builder and record-table helper). No public API, wire format, persisted format or client-visible message changes.
- Updated dependencies [[`7dada20`](https://github.com/yosuque/kohaku/commit/7dada207c923752a410219d26bd073216ee5814d), [`4742970`](https://github.com/yosuque/kohaku/commit/4742970f69c41259e940f656bf7605e42cb3f141)]:
  - @kohaku-ui/host-core@0.5.0
  - @kohaku-ui/spec-core@0.5.0
  - @kohaku-ui/composer@0.5.0
  - @kohaku-ui/evals@0.5.0
  - @kohaku-ui/lineage@0.5.0
  - @kohaku-ui/client@0.5.0
  - @kohaku-ui/registry@0.5.0
  - @kohaku-ui/sandbox@0.5.0
  - @kohaku-ui/storage-memory@0.5.0
  - @kohaku-ui/spec@0.5.0

## 0.4.1

### Patch Changes

- [#66](https://github.com/yosuque/kohaku/pull/66) [`4199e34`](https://github.com/yosuque/kohaku/commit/4199e34ae868b54da09961bc4312932e7546e9bf) Thanks [@yosuque](https://github.com/yosuque)! - `kohaku evidence verify` now refuses a FIFO or device node in place of a pack file (it used to block forever on a FIFO) and reports one as an unexpected file, and commander's own usage errors on `evidence verify` / `evidence export` (a missing required option, an unknown option) exit 2 instead of 1, so they no longer collide with "invalid pack".

- [#66](https://github.com/yosuque/kohaku/pull/66) [`1e446cc`](https://github.com/yosuque/kohaku/commit/1e446cc3f6bdbae47852c5adb0612fc58bd00271) Thanks [@yosuque](https://github.com/yosuque)! - `kohaku explain` escapes control characters (newlines included) in the lineage-derived strings it prints, so a tampered lineage record can neither inject terminal escape sequences nor forge an extra report line.

- [#79](https://github.com/yosuque/kohaku/pull/79) [`2c6b59c`](https://github.com/yosuque/kohaku/commit/2c6b59cd34f1eb48d9b24e089a9801459f445df7) Thanks [@yosuque](https://github.com/yosuque)! - A malformed `--header` value (no `:`, or an empty name) is now a usage error that exits 2, like the other bad arguments, in `explain`, `evidence export` and `usage export`. `explain` used to exit 1 for it, the same code as a failed request.

- [#66](https://github.com/yosuque/kohaku/pull/66) [`f5132f4`](https://github.com/yosuque/kohaku/commit/f5132f488a4b5a96f227468359a87b542976d553) Thanks [@yosuque](https://github.com/yosuque)! - The MCP Streamable HTTP server that `kohaku init --mcp` generates now shuts down gracefully on SIGINT / SIGTERM and documents that its Origin check is port-agnostic; `kohaku migrate --catalog` adds a hint (pass a built `.js`, or run under tsx) when the catalog module cannot be imported on plain Node.

- [#70](https://github.com/yosuque/kohaku/pull/70) [`28b09c3`](https://github.com/yosuque/kohaku/commit/28b09c392adebb0b3b2d1ff077f6592be088956b) Thanks [@yosuque](https://github.com/yosuque)! - `kohaku --help` and `kohaku init --help` no longer load the command implementations. Each subcommand now imports its own module (`commands`, `evidence`, `migrate`, `init`) when it runs, so a partial install (a missing optional workspace package) still prints help instead of failing with `ERR_MODULE_NOT_FOUND`. `writeScaffold` and `parseHeaderArgs` moved to the dependency-free `scaffold-fs` and `header-args` modules. Measured on the source launcher (tsx), `--help` went from a median of 539 ms to 381 ms over 5 runs; the built `dist/index.js` prints help in a median of 114 ms.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d) Thanks [@yosuque](https://github.com/yosuque)! - Compliance Evidence Pack (design.md decision 67): `verifyEvidencePack` now checks the signature over the raw `manifest.json` value before validating its shape, so a field added, removed or retyped after signing no longer verifies (the manifest schemas are strict and have no defaults, and the Python port matches). `buildEvidencePack` refuses to emit a file larger than the 64 MiB cap that verification enforces (new `maxFileBytes` option), instead of producing a pack that cannot be verified, and reports unparseable lines inside signed jsonl content.
  
  `approvals.jsonl` now also indexes `action.approvalRequested`, `action.approved`, `action.denied` and `policy.applied` events, so its bytes (and its manifest hash) change for any pack whose window contains them.
  
  `kohaku evidence export` now validates and canonicalizes `--since` / `--until` like the REST `/lineage` route (via the new `parseIso8601` export of spec-core, which host-rest now imports): `+hh:mm` offsets are converted to UTC, a date-only `--until` includes that whole UTC day, and an invalid or reversed window exits 2 instead of signing a wrongly scoped pack. The client's `lineagePages` and the pack builder throw instead of looping forever when a host returns the cursor it was given.

- [#71](https://github.com/yosuque/kohaku/pull/71) [`eb1f5b4`](https://github.com/yosuque/kohaku/commit/eb1f5b425751d049685258942e01edc94e23b94e) Thanks [@yosuque](https://github.com/yosuque)! - `kohaku init` now generates the golden fixture's `expected` right after `npm install` (one `npx vitest run` in update mode, with `CI` removed from the environment), so `npm test` in a fresh project is green instead of failing with "expected not generated". The step is best-effort: if it fails, init still succeeds and prints the manual `KOHAKU_GOLDEN_UPDATE=1 npm test` command. `InitResult` gains `goldenGenerated`, and `InitIo.run` accepts an `env` overlay (an `undefined` value removes the key).
  
  The generated `server/ports.ts` now passes `routes: { dev: process.env["NODE_ENV"] !== "production" }` to `createKohakuHost` (one startup warning line on stderr instead of the two production warnings; `routes.dev` rather than the top-level `dev`, so a missing `KOHAKU_CAPABILITY_SECRET` still fails fast) and carries a commented `auth` (marked as an insecure placeholder) / `authorizeGovernance` starting point; `.env` / `.env.example` document `NODE_ENV=production`, and the generated README gains a "Before production" section.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`12c4285`](https://github.com/yosuque/kohaku/commit/12c4285b126e898cdf23aa9f03793cbec29d68e1) Thanks [@yosuque](https://github.com/yosuque)! - `kohaku init --mcp`: the generated Streamable HTTP server now builds its host once per process (so the Spec cache, fixations and lineage survive across calls), validates the Host and Origin headers (localhost by default, `KOHAKU_MCP_ALLOWED_HOSTS` / `KOHAKU_MCP_ALLOWED_ORIGINS` to extend), no longer answers `Access-Control-Allow-Origin: *`, caps the request body at 4 MiB and closes its handler with the server. The generated README and next-steps text point at `server/ports.ts` and the new `fallbackIntent` option, and `init --mcp` now leads with `npm run mcp:claude-desktop`.

- [#76](https://github.com/yosuque/kohaku/pull/76) [`632f2d8`](https://github.com/yosuque/kohaku/commit/632f2d8f711bf73192f026973876e068ec4837bf) Thanks [@yosuque](https://github.com/yosuque)! - Usage metering derived from lineage (design.md [#74](https://github.com/yosuque/kohaku/issues/74)). `@kohaku-ui/lineage` adds the pure `summarizeUsage` (per-day, per-tenant rows: compositions, cache outcomes, tiers, L2 generations, fallbacks, LLM tokens from `view.composed`'s `decision.usage`, fixations), `mergeUsageRows` (adds two row lists key by key, so pages can be folded one at a time) `iterateLineagePages` (the cursor loop over a source's `pageLineage`, refusing a cursor that does not advance, now shared by the evidence pack builder and the usage export) and `LineageSummary.usage`, so `GET /analytics/summary` gains a `summary.usage` array (additive; the wire is otherwise unchanged). `l2Generated` counts the composes that actually generated an L2 Spec and succeeded: a record whose `payload.fallback` has kind `generation` or no kind (which keeps the L2 label when generation fails or the budget skips L2) and a single-flight follower (`decision.coalesced`) are not counted, while a negotiation downgrade (`fallback.kind` `negotiation`, applied to a Spec that was generated and paid for) is; `fallbacks` counts the `view.composed` records that carry `payload.fallback`, not `view.fallback` (the REST and the MCP profile both record one next to the composed record, so counting both would double-count). The Python `kohaku.lineage` mirrors both, plus `merge_usage_rows`. `@kohaku-ui/client` types it as `UsageRowView` (the new summary fields are optional there, since an older host omits them), and the admin Analytics tab shows a "Usage by day" table, labelled as a sample of the most recent events, with the fixation columns named for what they count (composes served from a fixation vs. fixation operations, the latter named `fixationsCreated` / `fixationsRemoved` in the rows and `fixations_created` / `fixations_removed` in the CSV). `@kohaku-ui/cli` adds `kohaku usage export` (`--data-dir` or `--rest`, `--since` / `--until`, `--format csv|json`, `--out`), which reads the whole lineage log, folding each chunk into the running rows instead of holding every event (`--data-dir` streams `lineage.jsonl` line by line in chunks of 500 matching events, opens only that file and writes nothing, so a corrupt `promotions.json` is left alone, and a malformed line is skipped, counted and warned about on stderr; `--rest` pages `GET /lineage`, each request limited by `--timeout-ms`, default 30000), and `--out` is written to `<out>.tmp` and renamed into place, and writes a fixed-header CSV for metering (lines end in LF; a tenant starting with `=`, `+`, `-` or `@` gets a leading apostrophe so a spreadsheet does not read it as a formula). A missing `--data-dir`, both or neither of `--data-dir` / `--rest`, an empty `--tenant` (which would read as no filter), and a `--tenant` that disagrees with the `x-kohaku-tenant` header exit 2 instead of exporting nothing or the wrong thing; the `tenant` option of `summarizeUsage` / `summarizeLineage` (and the Python mirror) now reads `""` as no filter, like a StoragePort, and a compose through an MCP host, which resolves no tenant, lands in the row whose tenant is empty; `evidence export` shares the same helpers, so its tenant / header mismatch now also exits 2. The host's in-process daily token ledger is not used for metering.

- [#64](https://github.com/yosuque/kohaku/pull/64) [`718b9e0`](https://github.com/yosuque/kohaku/commit/718b9e01c9f015881cc49db41af26e1d54c53519) Thanks [@yosuque](https://github.com/yosuque)! - `verifyCatalogMigrationPlan` now also recomputes each step's structure hash from its `pinnedSpec` and compares it with `afterStructureHash`, so a plan whose `pinnedSpec` was altered without touching its hashes is rejected before `kohaku migrate apply` writes anything (design.md decision 65). The Python port mirrors the change.
- Updated dependencies [[`a80f17a`](https://github.com/yosuque/kohaku/commit/a80f17a8ac304def877d23df9e7b8e37ef5c7396), [`67828f4`](https://github.com/yosuque/kohaku/commit/67828f4150934eb42a61b25f44390b4c0bacf604), [`e250463`](https://github.com/yosuque/kohaku/commit/e2504639145c3baacd1843c72512e8abf4f21b08), [`cb6e91a`](https://github.com/yosuque/kohaku/commit/cb6e91afdbbc083587cd32941ebac07b0151753a), [`b712fef`](https://github.com/yosuque/kohaku/commit/b712fef7404c6af1ca6ff726890eb6ddfd44dbfc), [`6bb1769`](https://github.com/yosuque/kohaku/commit/6bb1769feb9eed35f32e8e489453ceea6c932745), [`6b01a1f`](https://github.com/yosuque/kohaku/commit/6b01a1fe0e8ac5f640bbc0a482a3dbe43e6b353a), [`0c4d5a2`](https://github.com/yosuque/kohaku/commit/0c4d5a298ccabe2ca47cac00f4c33730c2b915b0), [`8eb466b`](https://github.com/yosuque/kohaku/commit/8eb466bc52a5259e897d1cbc1713e57796a702e7), [`06a724e`](https://github.com/yosuque/kohaku/commit/06a724e046a432e8c64af217911bb2683ab8ca9d), [`fc7b074`](https://github.com/yosuque/kohaku/commit/fc7b07414ea58b50b687cf9c72db4b2a51706df9), [`38da68b`](https://github.com/yosuque/kohaku/commit/38da68b1629df99aa7406f0068e2a479052f0cc4), [`71e17f9`](https://github.com/yosuque/kohaku/commit/71e17f9d970e01abaa8ebdf967054ad468555b56), [`5cfd417`](https://github.com/yosuque/kohaku/commit/5cfd417a7959c03a00587ad22b920b7fe62bf045), [`ab25ddc`](https://github.com/yosuque/kohaku/commit/ab25ddc5691e216e6d5d027920a0a9abbc8f4207), [`5d1f473`](https://github.com/yosuque/kohaku/commit/5d1f473064c1c489ce54441cf8c9841c1be3028d), [`206b95b`](https://github.com/yosuque/kohaku/commit/206b95b425800ec5af8f7e9ac203a8be70fd8d0b), [`b1d5322`](https://github.com/yosuque/kohaku/commit/b1d53226d659ce232156191ca9a7cdfd96e7d8ce), [`92ff930`](https://github.com/yosuque/kohaku/commit/92ff930f683391e2cd4de2a19b66a2e9ca04d49d), [`806c5f2`](https://github.com/yosuque/kohaku/commit/806c5f222097eaf6599a1fc12a5c24c11e83886f), [`343ccd7`](https://github.com/yosuque/kohaku/commit/343ccd7a71d4370473640dce94f1e2e2a821b39d), [`1e0d356`](https://github.com/yosuque/kohaku/commit/1e0d3564d6296bdae557e5d96376c798a3759b5f), [`7fa1981`](https://github.com/yosuque/kohaku/commit/7fa1981c6e574ba3e9f4eb570b88304c65565011), [`7c92cc4`](https://github.com/yosuque/kohaku/commit/7c92cc433e40a88f3b43eaeba7fd0af1a8755cad), [`8bd2e93`](https://github.com/yosuque/kohaku/commit/8bd2e93a305b2cfb12ddc394a8044b9dd9ca6378), [`a936266`](https://github.com/yosuque/kohaku/commit/a9362668b281564bc09a3b4a20233f8e1294bf41), [`837b4d2`](https://github.com/yosuque/kohaku/commit/837b4d27d3273daa9aa9d33b94e27c041a30c0ff), [`656de8e`](https://github.com/yosuque/kohaku/commit/656de8ec3aeb1ee311e25688b88437d450d9dfd9), [`adb2744`](https://github.com/yosuque/kohaku/commit/adb27442a9169eb74e803e88ec52d54db3a944b2), [`f8ecb4c`](https://github.com/yosuque/kohaku/commit/f8ecb4c71ba780378849c27c8ccdc6a14b31dcdc), [`632f2d8`](https://github.com/yosuque/kohaku/commit/632f2d8f711bf73192f026973876e068ec4837bf), [`718b9e0`](https://github.com/yosuque/kohaku/commit/718b9e01c9f015881cc49db41af26e1d54c53519)]:
  - @kohaku-ui/registry@0.4.1
  - @kohaku-ui/host-core@0.4.1
  - @kohaku-ui/spec-core@0.4.1
  - @kohaku-ui/client@0.4.1
  - @kohaku-ui/composer@0.4.1
  - @kohaku-ui/lineage@0.4.1
  - @kohaku-ui/storage-memory@0.4.1
  - @kohaku-ui/evals@0.4.1
  - @kohaku-ui/sandbox@0.4.1
  - @kohaku-ui/spec@0.4.1

## 0.4.0

### Minor Changes

- [#58](https://github.com/yosuque/kohaku/pull/58) [`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f) Thanks [@yosuque](https://github.com/yosuque)! - Add catalog migration: deprecate a part, roll out a replacement gradually, and bulk-rewrite the fixations
  still pinned on the old one (see `docs/design.md` decision [#65](https://github.com/yosuque/kohaku/issues/65)).
  
  - `@kohaku-ui/registry`: `ComponentDefinition` gains `deprecated?` (`{reason, since?, replacedBy?: {type,
    version?}, sunset?}`) and a TS-only `migrateProps?(props)` hook next to `fallback`. `resolveCatalog`
    validates that every `replacedBy` resolves in the merged catalog. A deprecated part drops out of the L1
    generation vocabulary but keeps validating Specs that already reference it, and the catalog fingerprint
    folds in a `!deprecated` suffix per such entry (every other entry's fingerprint contribution is
    unaffected). New `stagedCatalogFor({ stable, next, inRollout })` builds a `catalogFor`-shaped function for
    canary-rolling a migrated catalog in per tenant (tenant-neutral traffic always gets `stable`).
  - `@kohaku-ui/lineage`: `FIXATION_EVENT_TYPES` gains `intent.migrated`, recorded by a new
    `Fixations.replace(intentHash, pinnedSpec, { approver, guard, planId })` that rewrites a fixation's
    pinned structure in place (TOCTOU-guarded on the caller's observed revision/fixatedAt/structureHash/
    catalogFingerprint). `PromotionCandidate` also gains `origin` (kit/generatorVersion/model, read from
    `component.generated` and kept across every transition) — a promotion-review gap noted since U2.
  - `@kohaku-ui/host-core`: new `analyzeCatalogImpact` (broken fixations, deprecated-part usage, published
    promotions on a deprecated/removed part, origin-kit mismatches) and `planCatalogMigration` /
    `applyCatalogMigration` / `verifyCatalogMigrationPlan` (plan a bulk rewrite, revalidate it against the
    target catalog, then commit it through a host-supplied fixation-replace surface).
  - `@kohaku-ui/host-rest`: `GET /catalog` now serializes `deprecated` on each component (MAY, omitted when
    the part isn't deprecated).
  - `@kohaku-ui/client`: `SerializedComponentDef` / `CatalogResponse` gain `deprecated` /
    `SerializedDeprecation`; `PromotionCandidateView` gains `origin` / `PromotionOriginView`.
  - `@kohaku-ui/cli`: new `kohaku migrate plan --data-dir --catalog --out` (read-only) and `kohaku migrate
    apply --plan --approver --data-dir` (commits it; not safe to run concurrently with a live host sharing
    `--data-dir`).
  - `@kohaku-ui/admin-react`: the promotion card shows the candidate's generation kit/generatorVersion when
    known (`origin`, EN + JA copy).
  
  Fully additive: a catalog with no deprecated parts, a fixation store with no `intent.migrated` events, and a
  promotion record with no `origin` are all byte-identical to before this change.

- [#60](https://github.com/yosuque/kohaku/pull/60) [`5f1bbbd`](https://github.com/yosuque/kohaku/commit/5f1bbbd09fe1edb984a7b0f5a0c5212c3da628ea) Thanks [@yosuque](https://github.com/yosuque)! - Adds a Compliance Evidence Pack export (`@kohaku-ui/lineage`'s new `evidence` module; `kohaku evidence
  keygen`/`export`/`verify`) and opt-in AI-generation disclosure for both renderers (design.md [#66](https://github.com/yosuque/kohaku/issues/66)/[#67](https://github.com/yosuque/kohaku/issues/67)).
  
  **Evidence Pack** (`@kohaku-ui/lineage`): `buildEvidencePack` assembles a normalized, Ed25519-signed
  export of the lineage log (`events.jsonl`), a governance-decision index (`approvals.jsonl`:
  `component.reviewed`/`published`/`withdrawn`, `intent.fixated`/`unfixated`), promotion/fixation
  snapshots, and the referenced component HTML artifacts, plus `manifest.json` and a detached signature
  (`manifest.sig`). `EvidenceManifestSchema` is new but deliberately not part of `spec/schemas` — it
  describes an export format for auditors, not a wire type. Ed25519 signing uses `globalThis.crypto.subtle`
  (no new runtime dependency for TS); an artifact whose recorded hash does not match its own content is
  still exported, recorded as a non-fatal warning rather than aborting the export.
  
  **CLI** (`@kohaku-ui/cli`): `kohaku evidence keygen --out-dir <dir>` generates an Ed25519 keypair (private
  key file mode 0600). `kohaku evidence export (--data-dir <dir> | --rest <baseUrl> [--header k:v])
  [--tenant <id>] --since --until --private-key <pem> --out <dir> [--allow-incomplete]` builds and signs a
  pack from a local `StoragePort` data directory or, over REST, from the existing `KohakuClient` surface
  (`lineagePages`/`promotions.list`/`fixations.list`) — the REST source leaves `fixations.jsonl` empty with
  a recorded warning, since `GET /fixations` does not expose enough fields to reconstruct a full
  `FixationRecord`. `kohaku evidence verify <dir> --public-key <pem>` checks the manifest schema, the
  signature, and every file's hash/size, and reports an independent artifact-hash cross-check as non-fatal
  `mismatches`; exit code 0 valid / 1 invalid / 2 usage error. `@kohaku-ui/lineage` and
  `@kohaku-ui/storage-memory` move from `cli`'s devDependencies to dependencies.
  
  **AI-generation disclosure** (`@kohaku-ui/renderer-core`, `@kohaku-ui/renderer-react`,
  `@kohaku-ui/renderer-wc`): `deriveDisclosure(provenance)` (renderer-core) derives a disclosure level
  (`"ai-generated"` for tier L1/L2, `"ai-assisted-reviewed"` for a fixated tier-L0 Spec, `"none"` otherwise
  — never encoded on the wire) and the corresponding `data-kohaku-disclosure`/`data-kohaku-tier`/
  `data-digital-source-type` (IPTC Digital Source Type) attributes. `SpecView` gains a `disclosure?: "off" |
  "attributes" | "label"` prop (renderer-react; also exports `useDisclosure`/`KohakuDisclosureLabel`), and
  `<kohaku-surface>` gains a matching `disclosure` attribute (renderer-wc, applied to the host element,
  with the visible label — `"label"` mode only — inside the shadow root). Both default to `"off"`: existing
  DOM output is unchanged unless a host opts in.
  
  See [docs/user-guide.md](../docs/user-guide.md)'s "Compliance Evidence Pack and AI-generation disclosure"
  section for usage, EU AI Act Article 50 context (not legal advice), and a PII caution for exported Intent
  `params`/request text.

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Add `@kohaku-ui/host`, a new package: `createKohakuHost()` wires the default Port implementations
  (`createMemoryStoragePort`, `createHmacAuthzPort`, `createLlmSemanticPort` built from an `intents` catalog,
  `resolveCatalog(coreCatalog)`) into `@kohaku-ui/host-rest`'s `createKohakuRoutes` in one call, with every
  default independently overridable via `storage` / `authz` / `semantic` / `catalog`. `llm` is always required
  (never defaulted from a fake or the environment). `host-core`'s `createConsoleErrorReporter` is wired into
  both the REST profile's `onError` and the compose observer's `onError` by default. The capability secret for
  the default `authz` is resolved from `capabilitySecret` or the `KOHAKU_CAPABILITY_SECRET` environment
  variable; `dev: true` generates a temporary one (with a `console.warn`) instead of throwing, for local
  development only.
  
  MCP is a separate `@kohaku-ui/host/mcp` subpath (`attachKohakuMcp(server, host, options)`, calling
  `@kohaku-ui/host-mcp-apps`'s `attachKohakuToMcpServer` with the `compose` / Ports the facade already built) —
  `@kohaku-ui/host`'s main entry point never imports it, so a REST-only consumer never needs
  `@kohaku-ui/host-mcp-apps` or `@modelcontextprotocol/server` (both are optional peer dependencies of this
  package, not ordinary ones — install both yourself to use `./mcp`).
  
  `kohaku init`'s generated `server/app.ts` and `kohaku scaffold ports`'s scaffold are both rewired onto
  `createKohakuHost`: the generated project's direct `@kohaku-ui/*` dependencies drop from 15 to 10 (host-rest
  / host-core / semantic-llm / storage-memory / authz-hmac / registry are no longer imported directly), and
  `scaffold ports` now generates only a `DomainPort` (`ports.ts`) plus an Intent catalog (`intents.ts`, new
  file) instead of hand-writing all four Ports — 2 TODOs instead of 5.
  
  See `docs/design.md` decision [#52](https://github.com/yosuque/kohaku/issues/52) for the full rationale, including why MCP is a separate subpath.
  
  **Before its first release, a maintainer must bootstrap the new package** (`node scripts/npm-bootstrap.mjs
  --publish`, run from a maintainer's own terminal) — see `docs/runbooks/release.md`, "First publish of a new
  package": npm can only register a trusted publisher for a package that already exists on the registry, so
  `@kohaku-ui/host`'s own first publish cannot go through `release.yml`'s OIDC flow the way every other
  package's release already does.

- [#57](https://github.com/yosuque/kohaku/pull/57) [`b303d70`](https://github.com/yosuque/kohaku/commit/b303d702e1530698401c28c6ff50074ef632dac6) Thanks [@yosuque](https://github.com/yosuque)! - Add `@kohaku-ui/mcp-renderer`, a new package: the shared renderer that runs inside an MCP Apps iframe,
  distributed for reuse outside this repository (it used to live only inside `apps/sample-mcp`).
  
  - `.` — `loadRendererHtml(): Promise<string>` reads this package's own pre-built, single-file
    `dist/renderer.html` (the core kohaku component set, no product-specific implementations). **Zero npm
    dependencies** — a consumer that only wants the stock renderer installs nothing beyond this package.
  - `./boot` — `bootMcpRenderer({ registerImpls?, root? })` is the source the core build itself is built from,
    and what a product rebuilds with its own component implementations baked in (mirroring the Web app's
    registry overlay). Its `@kohaku-ui/renderer-react` / `renderer-core` / `data-binding` / `spec-core` /
    `@modelcontextprotocol/ext-apps` / `react` / `react-dom` dependencies are all optional peer dependencies —
    `.` never imports `./boot`, so they are never installed by a plain `npm install @kohaku-ui/mcp-renderer`.
  
  `apps/sample-mcp`'s own renderer (sales-domain implementations baked in) is now a thin rebuild against
  `./boot` instead of the renderer's original home.
  
  `kohaku init --mcp` generates an MCP front door on top of the always-generated REST one:
  `server/mcp-server.ts` (`attachMcpServer`, wiring the same host `server/ports.ts` builds onto
  `@kohaku-ui/host/mcp`'s `attachKohakuMcp`, with `@kohaku-ui/mcp-renderer`'s `loadRendererHtml` and typed
  MCP tools from the generated Intent catalog), `server/mcp.ts` (stdio, `npm run mcp`) and
  `server/mcp-http.ts` (Streamable HTTP on :8788, `npm run mcp:http`), plus a
  `claude_desktop_config.example.json` and `scripts/claude-desktop.mjs` (`npm run mcp:claude-desktop`
  registers the project with Claude Desktop, backing up its existing config to `.bak` first; `-- --print`
  previews the merge without writing anything — the real config is only ever touched by a person running
  this script themselves).
  
  `kohaku init`'s generated `server/app.ts` is split into `server/ports.ts` (`createPorts`, the
  `createKohakuHost()` call) + `server/app.ts` (the REST-specific facet-views / health routes on top of it),
  so the new MCP front door builds the same host without importing Hono routes it does not need.
  
  See `docs/design.md` decision [#56](https://github.com/yosuque/kohaku/issues/56) for the full rationale.
  
  **Before its first release, a maintainer must bootstrap the new package** (`node scripts/npm-bootstrap.mjs
  --publish`, run from a maintainer's own terminal) — see `docs/runbooks/release.md`, "First publish of a new
  package": npm can only register a trusted publisher for a package that already exists on the registry, so
  `@kohaku-ui/mcp-renderer`'s own first publish cannot go through `release.yml`'s OIDC flow the way every
  other already-published package's release does.

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Add `kohaku explain <requestId>` and Kohaku DevTools (`@kohaku-ui/admin-react/devtools`), answering "why
  did this view come out this way" from a request id alone: tier, cache hit/miss, the cache key's individual
  components, the L1/L2 decision flow (attempts, capability-negotiation downgrades, single-flight
  coalescing, token usage), capability scopes, and the related lineage events.
  
  - `ComposeTrace.cacheKeyParts` records the exact `CacheKeyParts` a compose's `cacheKey` was built from
    (the opaque, colon-joined `cacheKey` string cannot be split back apart after the fact).
  - `view.composed` / `component.generated` / `component.used` / `view.fallback` lineage payloads gain
    `correlationId`, `cacheKey`, `cacheKeyParts`, `generatorVersion`, `kit`, `fallback`, and a `decision`
    summary — all optional and omitted when unset, so every pre-existing event keeps its exact shape.
  - `host-mcp-apps`' MCP compose correlation id is now `mcp:<sessionId>:<jsonrpc id>` (or `mcp:<jsonrpc id>`
    for a session-less transport such as stdio), replacing the bare JSON-RPC request id.
  - `@kohaku-ui/client` reads a compose response's `X-Request-Id` header (`ComposeView.requestId`, the
    stream's `done` event), adds `KohakuClientConfig.onResponse`, and exposes `client.explain(requestId)` /
    the pure `buildExplainReport(events, spec?)`.
  - `kohaku explain <requestId> --rest <baseUrl>` renders the explain report as text or JSON (`--json`),
    optionally with capability scopes (`--spec <file>`).
  - `@kohaku-ui/admin-react/devtools`'s `KohakuDevTools` component (+ `withDevToolsCapture` for a
    "recent requests" quick-pick) renders the same report across six panels, on its own subpath decoupled
    from `AdminProvider`/`KohakuAdmin` (same dependency boundary as the package root: client / renderer-core
    / sandbox / spec-core only, never `renderer-react`).
  
  See docs/user-guide.md's "Kohaku DevTools and `kohaku explain`" section, including the
  `Access-Control-Expose-Headers: X-Request-Id` CORS requirement for a browser-hosted client.

### Patch Changes

- [#55](https://github.com/yosuque/kohaku/pull/55) [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049) Thanks [@yosuque](https://github.com/yosuque)! - Makes a fallback's reason and an `onError` observation honest about *why* generation degraded, instead of
  collapsing every non-happy-path into the same wording.
  
  `composer`'s L1 tier ladder previously returned the identical "L1 constrained generation failed
  catalog/structure validation" reason whether the LLM provider was actually unreachable (a transient
  error) or the model answered but its output failed validation. A transient failure now gets its own
  reason naming the provider (with the underlying `LlmError` code in parentheses when known, e.g. "(provider
  error)") and pointing at `KOHAKU_LLM_PROVIDER`/the provider API key; the validation-failure wording is
  unchanged. New `ComposeErrorContext.failure` and `TierResult.lastError` let `observer.onError` receive the
  classified failure kind and the underlying error (previously always `undefined` for a fallback) without
  string-matching `reason`.
  
  `refs.ts`'s `SEMANTIC_FAILED` wrapping now appends a `resolveQuery` failure's own message when the cause
  explicitly opts in with a readonly `clientSafe: true` property, so e.g. an unknown Intent name reaches the
  caller instead of the generic "query resolution failed" alone. This is deliberately narrower than "any
  error with a string `code`" (host-core's existing `isTypedHostError` convention): a `SemanticPort` commonly
  delegates to a database/filesystem/HTTP client whose own errors also carry a string `code` (e.g.
  `ECONNREFUSED`) while their `message` can contain hostnames, paths, or table names, so `code` alone is not
  safe to trust here — every cause without `clientSafe: true` is left exactly as before. `semantic-llm`'s
  `resolveQuery` now throws a typed `UnknownIntentError` (exported, `clientSafe: true`) instead of a plain
  `Error`, so its own unknown-intent failures benefit from this.
  
  New `host-core` `formatErrorChain` (walks `Error.cause`, depth-capped against cycles) and
  `createConsoleErrorReporter` (a pair of handlers pre-wired to `KohakuHostDeps.onError` and
  `ComposeObserver.onError`'s exact signatures) give a generated project sensible default logging.
  `kohaku init` wires both hooks in the generated `app.ts`, gated by a new `KOHAKU_DEBUG` env var
  (documented in `.env.example`): unset/any other value keeps today's one-line summaries, `KOHAKU_DEBUG=1`
  prints the full cause chain and stack trace instead.
- Updated dependencies [[`fcd4eb7`](https://github.com/yosuque/kohaku/commit/fcd4eb7c8c6608030d4f9045648a305fa2e5992f), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5f1bbbd`](https://github.com/yosuque/kohaku/commit/5f1bbbd09fe1edb984a7b0f5a0c5212c3da628ea), [`cc17b7b`](https://github.com/yosuque/kohaku/commit/cc17b7bc3c96e49b1b74197ac20cd7a3d8ee0b47), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049), [`5d167cb`](https://github.com/yosuque/kohaku/commit/5d167cb386cc1f91102644f8a99bd5b5c2949ce0), [`730e625`](https://github.com/yosuque/kohaku/commit/730e62584b249056078792f6f646019cb225b049)]:
  - @kohaku-ui/registry@0.4.0
  - @kohaku-ui/lineage@0.4.0
  - @kohaku-ui/host-core@0.4.0
  - @kohaku-ui/client@0.4.0
  - @kohaku-ui/storage-memory@0.4.0
  - @kohaku-ui/evals@0.4.0
  - @kohaku-ui/spec-core@0.4.0
  - @kohaku-ui/composer@0.4.0
  - @kohaku-ui/spec@0.4.0
  - @kohaku-ui/sandbox@0.4.0

## 0.3.0

### Minor Changes

- [#32](https://github.com/yosuque/kohaku/pull/32) [`b19b7c1`](https://github.com/yosuque/kohaku/commit/b19b7c156304c2e63ce9d1851d5bd0479442fd62) Thanks [@yosuque](https://github.com/yosuque)! - `kohaku init`'s generated project no longer falls back to a fixed `dev-secret-change-me` capability secret:
  `server/app.ts` now throws `KOHAKU_CAPABILITY_SECRET is required (see .env.example)` when it is unset, and
  `initProject` writes a real, randomly generated secret (`randomBytes(32).toString("base64url")`) to a
  git-ignored `.env` so the generated project still runs out of the box; `.env.example` now ships that var
  empty (with a comment) instead of a shared placeholder value, and the generated `server/app.ts` loads `.env`
  itself so this also works when it's imported directly (the golden test, scripting) rather than only via
  `server/main.ts`.
  
  `@kohaku-ui/llm`'s `resolveLlmEnv` now treats an empty-string (or whitespace-only) `KOHAKU_LLM_API_KEY` or
  provider-standard key env var as unset instead of a configured empty key — needed because the generated
  `.env.example`'s `KOHAKU_LLM_API_KEY=` placeholder previously defeated the fallback to `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` once loaded via `process.loadEnvFile`.
  
  Also: the CLI's own description and `--help` text now mention `init` / project generation; `kohaku init`'s
  "Next steps" output and the generated README point at the one-time `KOHAKU_GOLDEN_UPDATE=1 npm test`; the
  generated README notes that Chat only answers within the generated Intent catalog (`NO_MATCH` otherwise,
  widened via `fallbackIntent`); and the root README / user guide point at
  `cli/test/init/fixtures/sales.csv` for anyone without a CSV of their own to try.

- [#27](https://github.com/yosuque/kohaku/pull/27) [`a853a99`](https://github.com/yosuque/kohaku/commit/a853a99131d723211b511c33c5cb7bd75f8fe16c) Thanks [@yosuque](https://github.com/yosuque)! - Zero-Port quickstart: `kohaku init --from <data.csv|.json|.sqlite>` generates a runnable app (DomainPort, Intent catalog, L0 fixed Spec, Dashboard + Chat, golden test) that depends only on the published packages. New package `@kohaku-ui/semantic-llm` provides the default SemanticPort (`createLlmSemanticPort`) and a generic Intent catalog; the sample API now builds on it.

### Patch Changes

- [#33](https://github.com/yosuque/kohaku/pull/33) [`79d4307`](https://github.com/yosuque/kohaku/commit/79d430747add16102065f9ff9f0f7c1071750094) Thanks [@yosuque](https://github.com/yosuque)! - Dependency updates: the Vercel AI SDK (`ai` ^7.0.108, `@ai-sdk/anthropic` ^4.0.58, `@ai-sdk/openai` ^4.0.72, `@ai-sdk/google` ^4.0.76, `@ai-sdk/openai-compatible` ^3.0.53). Projects generated by `kohaku init` now pin `@ai-sdk/anthropic` ^4.0.58, `@ai-sdk/openai-compatible` ^3.0.53, `@types/node` ^26.6.2 and `tsx` ^4.23.15.
- Updated dependencies [[`a26f9be`](https://github.com/yosuque/kohaku/commit/a26f9be35f5702287e79f67f13bd3298bfb73bc5), [`ad51284`](https://github.com/yosuque/kohaku/commit/ad5128464169d389e0c462c59184d411ba359d8e), [`cffc1aa`](https://github.com/yosuque/kohaku/commit/cffc1aac259bfdc8f22c48ae57427a809853924e), [`9e227c9`](https://github.com/yosuque/kohaku/commit/9e227c9dd2ceda6b9c2483296be4b4dc0e090bfd), [`cd12831`](https://github.com/yosuque/kohaku/commit/cd12831667055a0d7aec31453dcc6a7e3448e47c)]:
  - @kohaku-ui/spec-core@0.3.0
  - @kohaku-ui/evals@0.3.0
  - @kohaku-ui/spec@0.3.0
  - @kohaku-ui/composer@0.3.0
  - @kohaku-ui/sandbox@0.3.0

## 0.2.0

### Patch Changes

- [#18](https://github.com/yosuque/kohaku/pull/18) [`108b3b3`](https://github.com/yosuque/kohaku/commit/108b3b33465050592df72d35bed8cf9ab16d6711) Thanks [@yosuque](https://github.com/yosuque)! - Stop declaring `tsx` as a runtime dependency of the published CLI. The published `kohaku` bin runs the compiled `dist/index.js`, so `npx @kohaku-ui/cli` no longer downloads tsx/esbuild; the in-repo `bin/kohaku.js` launcher still resolves tsx from the workspace.
- Updated dependencies [[`642330d`](https://github.com/yosuque/kohaku/commit/642330d89c85b47716a28b0a7fde36097e7e50ef), [`ffff046`](https://github.com/yosuque/kohaku/commit/ffff046628f1779bbc9b1a1a4c9d4256f82a9cd3), [`cf2623c`](https://github.com/yosuque/kohaku/commit/cf2623cd2688969db1156d0817ffff08bbe3f610), [`8f6fe5a`](https://github.com/yosuque/kohaku/commit/8f6fe5aaee025c83c8494f5dc4bd97a2a7513b11), [`cec01e1`](https://github.com/yosuque/kohaku/commit/cec01e166d2947fe8b4bbbfbe5c306c33aaccf99), [`b922703`](https://github.com/yosuque/kohaku/commit/b9227038c12dcaf790697b5ca8f1e70c98abc154), [`01ed79f`](https://github.com/yosuque/kohaku/commit/01ed79fb52322acafabe89736561d8a66b2ccd39), [`1c2a1da`](https://github.com/yosuque/kohaku/commit/1c2a1da8760ce3af8a49d90d803f6a574c851bbe), [`a318995`](https://github.com/yosuque/kohaku/commit/a318995245309f7b492b52a44fbae1a8c891a353), [`cb9f653`](https://github.com/yosuque/kohaku/commit/cb9f6538511151dd59980cc5e98c19d16f3f099d)]:
  - @kohaku-ui/composer@0.2.0
  - @kohaku-ui/spec-core@0.2.0
  - @kohaku-ui/sandbox@0.2.0
  - @kohaku-ui/evals@0.2.0
  - @kohaku-ui/spec@0.2.0
