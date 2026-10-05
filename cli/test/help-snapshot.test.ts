import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Characterization of `--help` for the program and every (nested) subcommand. The command wiring is split
// across modules under `src/cli/`; this suite pins that the split changes no help byte (names, descriptions,
// option order, required markers, defaults).

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "../bin/kohaku.js");

function help(...args: string[]): string {
  const result = spawnSync(process.execPath, [bin, ...args, "--help"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

describe("--help snapshots", () => {
  it("kohaku", () => {
    expect(help()).toMatchInlineSnapshot(`
      "Usage: kohaku [options] [command]

      CLI for kohaku: protocol conformance checks, scaffolding, project generation and
      component validation

      Options:
        -V, --version                  output the version number
        -h, --help                     display help for command

      Commands:
        conformance [options]          Run the specification conformance suite
                                       (SPEC.md §7)
        explain [options] <requestId>  Explain why a compose came out the way it did
                                       (tier, cache, cache-key breakdown, decision
                                       flow, related lineage events)
        scaffold [options] <what>      Generate scaffolds for product-side Port
                                       implementations / Golden regression tests
        init [options]                 Generate a runnable kohaku app (server +
                                       dashboard + chat) from a data file, then npm
                                       install
        smoke-l2                       Validate the L2 HTML from stdin and return
                                       issues as JSON (for sidecar use by
                                       implementations without a JS runtime).stdin:
                                       {"html":"...","mode":"lint"|"smoke","shape"?:DataShape,"readyTimeoutMs"?:number}
                                       / stdout: {"issues":string[]}. mode
                                       lint=<script> syntax check /
                                       smoke=ready-reached check under jsdom execution
        component                      Operations on component packages
        dataset                        Operations on distillation datasets
        evidence                       Operations on Compliance Evidence Packs
                                       (design.md #67) -- see docs/user-guide.md for
                                       the EU AI Act Article 50 disclosure-evidence
                                       context (not legal advice)
        usage                          Usage metering derived from the lineage log
                                       (design.md #74)
        migrate                        Catalog migration: rewrite fixated Specs off a
                                       deprecated part (design.md #65)
        help [command]                 display help for command
      "
    `);
  }, 30_000);

  it("conformance", () => {
    expect(help("conformance")).toMatchInlineSnapshot(`
      "Usage: kohaku conformance [options]

      Run the specification conformance suite (SPEC.md §7)

      Options:
        --self            Self-check of the Spec format only
        --rest <baseUrl>  Black-box check against a REST host (e.g.
                          http://localhost:8787/api/kohaku)
        --intent <json>   Intent used for the check (default: sales.quarterly_summary)
        -h, --help        display help for command
      "
    `);
  }, 30_000);

  it("explain", () => {
    expect(help("explain")).toMatchInlineSnapshot(`
      "Usage: kohaku explain [options] <requestId>

      Explain why a compose came out the way it did (tier, cache, cache-key breakdown,
      decision flow, related lineage events)

      Arguments:
        requestId              Request id to explain (a compose's X-Request-Id, or an
                               MCP tool call's mcp:... correlation id)

      Options:
        --rest <baseUrl>       REST host base URL (e.g.
                               http://localhost:8787/api/kohaku)
        --header <name:value>  Extra request header, e.g. tenant or auth (repeatable)
                               (default: [])
        --json                 Output the raw ExplainReport JSON instead of formatted
                               text
        --spec <file>          Path to a UISpec JSON file; adds capability scopes to
                               the report
        -h, --help             display help for command
      "
    `);
  }, 30_000);

  it("scaffold", () => {
    expect(help("scaffold")).toMatchInlineSnapshot(`
      "Usage: kohaku scaffold [options] <what>

      Generate scaffolds for product-side Port implementations / Golden regression
      tests

      Arguments:
        what         "ports" or "golden"

      Options:
        --out <dir>  Output directory (default depends on the target)
        -h, --help   display help for command
      "
    `);
  }, 30_000);

  it("init", () => {
    expect(help("init")).toMatchInlineSnapshot(`
      "Usage: kohaku init [options]

      Generate a runnable kohaku app (server + dashboard + chat) from a data file,
      then npm install

      Options:
        --from <file>    Data file: .csv, .json (array of objects) or .sqlite / .db
        --out <dir>      Output directory (default: the current directory)
        --source <name>  Intent catalog prefix / query source (default: the data
                         file's basename)
        --name <name>    package.json name (default: the output directory's basename)
        --table <name>   SQLite table to read (default: the first user table)
        --no-install     Skip npm install
        --mcp            Also generate the MCP front door (stdio + Streamable HTTP
                         servers, for Claude Desktop / claude.ai / ChatGPT)
        -h, --help       display help for command
      "
    `);
  }, 30_000);

  it("smoke-l2", () => {
    expect(help("smoke-l2")).toMatchInlineSnapshot(`
      "Usage: kohaku smoke-l2 [options]

      Validate the L2 HTML from stdin and return issues as JSON (for sidecar use by
      implementations without a JS runtime).stdin:
      {"html":"...","mode":"lint"|"smoke","shape"?:DataShape,"readyTimeoutMs"?:number}
      / stdout: {"issues":string[]}. mode lint=<script> syntax check /
      smoke=ready-reached check under jsdom execution

      Options:
        -h, --help  display help for command
      "
    `);
  }, 30_000);

  it("component", () => {
    expect(help("component")).toMatchInlineSnapshot(`
      "Usage: kohaku component [options] [command]

      Operations on component packages

      Options:
        -h, --help       display help for command

      Commands:
        validate <file>  Validate a component definition (JSON-serialized form)
        publish          (unimplemented) Publish a component to the federated registry
        help [command]   display help for command
      "
    `);
  }, 30_000);

  it("component validate", () => {
    expect(help("component", "validate")).toMatchInlineSnapshot(`
      "Usage: kohaku component validate [options] <file>

      Validate a component definition (JSON-serialized form)

      Arguments:
        file        JSON file of a ComponentDefinition

      Options:
        -h, --help  display help for command
      "
    `);
  }, 30_000);

  it("component publish", () => {
    expect(help("component", "publish")).toMatchInlineSnapshot(`
      "Usage: kohaku component publish [options]

      (unimplemented) Publish a component to the federated registry

      Options:
        -h, --help  display help for command
      "
    `);
  }, 30_000);

  it("dataset", () => {
    expect(help("dataset")).toMatchInlineSnapshot(`
      "Usage: kohaku dataset [options] [command]

      Operations on distillation datasets

      Options:
        -h, --help        display help for command

      Commands:
        export [options]  Export fixated (and optionally golden) Specs as a JSONL
                          distillation dataset (one canonical-JSON line per Spec:
                          {intent, refs, shape?, target: {components, events}, source,
                          meta})
        help [command]    display help for command
      "
    `);
  }, 30_000);

  it("dataset export", () => {
    expect(help("dataset", "export")).toMatchInlineSnapshot(`
      "Usage: kohaku dataset export [options]

      Export fixated (and optionally golden) Specs as a JSONL distillation dataset
      (one canonical-JSON line per Spec: {intent, refs, shape?, target: {components,
      events}, source, meta})

      Options:
        --fixations <path>  fixations.json snapshot ({key -> FixationRecord};
                            sample-api's .data/fixations.json can be passed directly)
        --golden <dir>      Directory of golden fixture JSON files ({name, input,
                            drafts, expected}) or plain UISpec JSON files
        --tenant <id>       Restrict the export to this tenant's fixations. Without
                            it, the output spans every tenant present in --fixations
        --out <path>        Output JSONL file path
        -h, --help          display help for command
      "
    `);
  }, 30_000);

  it("evidence", () => {
    expect(help("evidence")).toMatchInlineSnapshot(`
      "Usage: kohaku evidence [options] [command]

      Operations on Compliance Evidence Packs (design.md #67) -- see
      docs/user-guide.md for the EU AI Act Article 50 disclosure-evidence context (not
      legal advice)

      Options:
        -h, --help              display help for command

      Commands:
        keygen [options]        Generate a fresh Ed25519 keypair for signing/verifying
                                evidence packs
        export [options]        Assemble and sign a Compliance Evidence Pack from a
                                local StoragePort data directory or a REST host
        verify [options] <dir>  Verify a Compliance Evidence Pack's signature and file
                                integrity
        help [command]          display help for command
      "
    `);
  }, 30_000);

  it("evidence keygen", () => {
    expect(help("evidence", "keygen")).toMatchInlineSnapshot(`
      "Usage: kohaku evidence keygen [options]

      Generate a fresh Ed25519 keypair for signing/verifying evidence packs

      Options:
        --out-dir <dir>  Output directory for the generated key files (mode 0600 on
                         the private key)
        --force          Overwrite an existing key file (permanently invalidates every
                         pack signed with the old key)
        -h, --help       display help for command
      "
    `);
  }, 30_000);

  it("evidence export", () => {
    expect(help("evidence", "export")).toMatchInlineSnapshot(`
      "Usage: kohaku evidence export [options]

      Assemble and sign a Compliance Evidence Pack from a local StoragePort data
      directory or a REST host

      Options:
        --data-dir <dir>       Read from a local StoragePort data directory (mutually
                               exclusive with --rest)
        --rest <baseUrl>       Read over REST from a running host (mutually exclusive
                               with --data-dir). The pack is ALWAYS incomplete
                               (complete: false, fixations.jsonl empty) by design: GET
                               /fixations cannot supply full fixation records. Use
                               --data-dir (or a direct StoragePort) for a complete
                               pack
        --header <name:value>  Extra REST request header, e.g. tenant or auth
                               (repeatable; --rest only) (default: [])
        --tenant <id>          Restrict the export to this tenant. In --rest mode this
                               must match the x-kohaku-tenant --header (the header is
                               what actually scopes the request); omit --tenant to
                               have it derived from the header
        --since <iso8601>      Inclusive lower bound of the exported lineage window: a
                               date (YYYY-MM-DD, start of that UTC day) or a timestamp
                               with a Z / ±hh:mm offset
        --until <iso8601>      Inclusive upper bound of the exported lineage window: a
                               date (YYYY-MM-DD, which INCLUDES that whole UTC day) or
                               a timestamp with a Z / ±hh:mm offset
        --private-key <pem>    Path to a PEM-encoded Ed25519 private key (PKCS8)
        --out <dir>            Output directory for the pack
        --allow-incomplete     Fall back to a bounded lineage read (and mark the pack
                               incomplete) when exhaustive paging is unsupported
        -h, --help             display help for command
      "
    `);
  }, 30_000);

  it("evidence verify", () => {
    expect(help("evidence", "verify")).toMatchInlineSnapshot(`
      "Usage: kohaku evidence verify [options] <dir>

      Verify a Compliance Evidence Pack's signature and file integrity

      Arguments:
        dir                 Evidence pack directory

      Options:
        --public-key <pem>  Path to a PEM-encoded Ed25519 public key (SPKI)
        -h, --help          display help for command
      "
    `);
  }, 30_000);

  it("usage", () => {
    expect(help("usage")).toMatchInlineSnapshot(`
      "Usage: kohaku usage [options] [command]

      Usage metering derived from the lineage log (design.md #74)

      Options:
        -h, --help        display help for command

      Commands:
        export [options]  Export per-day, per-tenant usage (compositions, cache,
                          tiers, L2 generations, fallbacks, tokens, fixations) from
                          the whole lineage log of a local StoragePort data directory
                          or a REST host
        help [command]    display help for command
      "
    `);
  }, 30_000);

  it("usage export", () => {
    expect(help("usage", "export")).toMatchInlineSnapshot(`
      "Usage: kohaku usage export [options]

      Export per-day, per-tenant usage (compositions, cache, tiers, L2 generations,
      fallbacks, tokens, fixations) from the whole lineage log of a local StoragePort
      data directory or a REST host

      Options:
        --data-dir <dir>       Read from a local StoragePort data directory (mutually
                               exclusive with --rest)
        --rest <baseUrl>       Read over REST from a running host (mutually exclusive
                               with --data-dir). The x-kohaku-tenant --header decides
                               the tenant (export each tenant with its own header);
                               without the header every tenant is read (legacy,
                               unscoped hosts)
        --header <name:value>  Extra REST request header, e.g. tenant or auth
                               (repeatable; --rest only) (default: [])
        --tenant <id>          Restrict the export to this tenant (--data-dir; omitted
                               = every tenant, one row per day and tenant). In --rest
                               mode this must match the x-kohaku-tenant --header
        --since <iso8601>      Inclusive lower bound: a date (YYYY-MM-DD, start of
                               that UTC day) or a timestamp with a Z / ±hh:mm offset
        --until <iso8601>      Inclusive upper bound: a date (YYYY-MM-DD, which
                               INCLUDES that whole UTC day) or a timestamp with a Z /
                               ±hh:mm offset
        --timeout-ms <ms>      Time limit of each --rest request, in milliseconds (a
                               slower request fails the export) (default: "30000")
        --format <csv|json>    Output format (default: "csv")
        --out <file>           Write to this file instead of stdout (written to
                               <file>.tmp first, then renamed into place)
        -h, --help             display help for command
      "
    `);
  }, 30_000);

  it("migrate", () => {
    expect(help("migrate")).toMatchInlineSnapshot(`
      "Usage: kohaku migrate [options] [command]

      Catalog migration: rewrite fixated Specs off a deprecated part (design.md #65)

      Options:
        -h, --help       display help for command

      Commands:
        plan [options]   Compute (read-only) a rewrite plan for every
                         deprecated-with-replacement catalog type
        apply [options]  Commit a previously computed plan's steps. IMPORTANT: stop
                         any host process sharing --data-dir first — apply writes
                         through a file-backed StoragePort that is not safe for
                         concurrent writers.
        help [command]   display help for command
      "
    `);
  }, 30_000);

  it("migrate plan", () => {
    expect(help("migrate", "plan")).toMatchInlineSnapshot(`
      "Usage: kohaku migrate plan [options]

      Compute (read-only) a rewrite plan for every deprecated-with-replacement catalog
      type

      Options:
        --data-dir <dir>    StoragePort data directory (fixations.json /
                            promotions.json / lineage.jsonl)
        --catalog <module>  Path to an ESM module whose default (or named
                            "catalogFor") export is (tenant?: string) =>
                            ResolvedCatalog
        --tenant <id>       Restrict planning to this tenant's fixations (default: the
                            tenant-neutral sweep only)
        --out <path>        Output plan JSON file path
        -h, --help          display help for command
      "
    `);
  }, 30_000);

  it("migrate apply", () => {
    expect(help("migrate", "apply")).toMatchInlineSnapshot(`
      "Usage: kohaku migrate apply [options]

      Commit a previously computed plan's steps. IMPORTANT: stop any host process
      sharing --data-dir first — apply writes through a file-backed StoragePort that
      is not safe for concurrent writers.

      Options:
        --plan <path>       Plan JSON file produced by \`migrate plan\`
        --approver <id>     Principal id recorded as the approver on each
                            intent.migrated audit event
        --data-dir <dir>    StoragePort data directory (must match the one --plan was
                            computed against)
        --catalog <module>  Path to the *live* catalog module (same contract as
                            \`plan\`'s --catalog). Every step is refused (reported as
                            blocked, nothing written) if this catalog has drifted from
                            the one the plan targeted
        -h, --help          display help for command
      "
    `);
  }, 30_000);
});
