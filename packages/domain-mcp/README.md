# @kohaku-ui/domain-mcp

Turns an existing MCP server into a kohaku `DomainPort`. Read-only tools become `query://` references; every
other tool becomes a governed Action with `tier: "approve"`.

> **Use this only with MCP servers you trust.** The classification rests on the server's own
> `annotations.readOnlyHint`, which MCP defines as a *hint*. A server that marks a write tool read-only gets that
> tool resolved as a plain read, with no approval gate. To decide for yourself, pass `isReadOnly(tool)` (and/or
> `include(tool)`) to `createMcpDomainPort`.

```bash
npm install @kohaku-ui/domain-mcp @kohaku-ui/host @kohaku-ui/authz-hmac @kohaku-ui/llm zod
npm install @modelcontextprotocol/client   # the MCP client you pass in; this package never imports it
```

```ts
import { createHmacApprovalPort } from "@kohaku-ui/authz-hmac";
import { createMcpDomainPort, createMcpIntents } from "@kohaku-ui/domain-mcp";
import { createGovernancePolicy, createKohakuHost } from "@kohaku-ui/host";
import { createLlmFromEnv } from "@kohaku-ui/llm";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client({ name: "my-kohaku-host", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://upstream.example/mcp")));

const domain = await createMcpDomainPort({
  client, // anything matching McpToolClientLike works (listTools / callTool)
  onSchemaProjection: (report) => console.warn(report), // { tool, dropped, omitted, reasons }
});

const host = createKohakuHost({
  domain,
  querySource: "orders",
  llm: createLlmFromEnv(),
  intents: createMcpIntents(domain, { source: "orders" }), // one Intent per read-only tool
  describeShape: (ref) => domain.describeShape(ref), // columns from the tool's outputSchema
  dataVersion: domain.dataVersion, // the function the port stamps on the data
  routes: {
    // Without an ApprovalPort and a governance policy, every approve-tier write stays refused.
    approvals: createHmacApprovalPort(process.env.KOHAKU_CAPABILITY_SECRET!),
    authorizeGovernance: createGovernancePolicy({ roles: { approver: ["action.approve"] } }),
    // plus `auth`, so requests carry a principal
  },
});
```

## What it does

- **Classification.** `annotations.readOnlyHint === true` makes a tool a query (`domain.queryOps`). Everything else,
  including a tool with no annotation (MCP's default is `false`), is an Action (`domain.actionOps`) with
  `tier: "approve"`; `tierFor(tool)` overrides that for non-read-only tools. `include(tool)` leaves tools out, and
  `isReadOnly(tool)` replaces the hint check. Caveat: the host refuses a `"confirm"` / `"approve"` operation on the read
  path (SPEC ACT-RD-001), so `tierFor(tool) === "auto"` on a write tool leaves it reachable through a `query://` read
  ref, without the `paramsSchema` check, if such a ref is ever issued (`createMcpIntents` never emits one).
- **Queries.** `invoke` coerces the ref's string parameters by the tool's `inputSchema` type (`number`, `integer`,
  `boolean`; a nullable `anyOf` is read through), never forwards `_cursor` / `_sort` / `_dir`, maps `_limit` onto the
  tool's own numeric `limit`, calls the tool, and converts the result to `TabularData`: `structuredContent`, else the
  first JSON text block, as an array, `{ rows: [...] }`, or an object with a single array property. Columns are
  inferred from the **first 50 rows** only (`number` / `boolean` / `date` / `string`).
- **Actions.** The payload goes to the tool unchanged. Its `paramsSchema` is the tool's `inputSchema` *projected*
  onto kohaku's closed JSON Schema subset:
  - annotations (`description`, `title`, `default`, ...), `format`, `pattern` and a few other constraints are
    dropped; the approver-facing `description` of the operation says how many constraints were omitted;
  - every object is closed with `additionalProperties: false`, so an extra key the upstream would have accepted is
    **refused** (the projection can be stricter than the server in that one way, and looser wherever a constraint
    was dropped);
  - a property written as `anyOf: [X, { type: "null" }]` (Pydantic's `Optional[X]`) becomes the optional property
    `X`; an explicit null is then rejected;
  - a schema with any other `anyOf` / `oneOf` / `$ref`, a type array, `additionalProperties: true` or an unknown
    keyword is omitted entirely: kohaku cannot validate that Action's payload, the description says so, and the
    approver judges the raw payload.

  Both outcomes are reported through `onSchemaProjection`.
- **Intents.** `createMcpIntents` makes an `IntentDef` per read-only tool: params come from string / string-enum /
  number / integer properties. An optional parameter of any other type (boolean, array, object, a genuine union) is
  silently left out, so it cannot be set through an Intent; a tool that *requires* one is skipped (`onSkip`). The
  canonical name is `<source>.<tool name lowercased, characters outside [a-z0-9_] replaced by "_">` (prefixed `t_` if
  it would not start with a letter); two tools mapping to the same name make it throw. A write tool never gets an
  Intent, and a read capability is only ever issued for an Intent's resolved refs. **A hand-written Intent must
  never point at an action op (`domain.actionOps`).** A host-level guard against that is planned separately.
- **Data version.** MCP has none, so the port stamps `mcpDataVersion()` (`mcp:<floor(now / 300 s)>`) on the data,
  and `domain.dataVersion` is that same function, to hand to the host. A Spec composed just before a bucket boundary
  is stale once after it, and a successful write does not change the version until the next bucket. Pass
  `dataVersion` to the port to use your own.
- **Shape.** `domain.describeShape(ref)` builds a `DataShape` from the tool's `outputSchema` (`string` is a
  dimension, `number` / `integer` a measure, `format: date | date-time` a time column), or `null`.

## Limits and options

| Option | Default | Meaning |
|---|---|---|
| `callTimeoutMs` | 30000 | Deadline of one upstream call. The request is aborted (an `AbortSignal` goes to `callTool`, and the SDK's own `timeout` is set 5 s later) and **never retried**. A write that times out says "the upstream tool did not answer in time; its effect is unknown". |
| `maxLimit` | 1000 | Ceiling for the tool's numeric `limit`. `_limit` can only lower the signed `limit`: the smaller of the two wins. |
| `maxRows` | 10000 | More rows in one query result is an error (a fixed message). |
| `maxResultBytes` | 10 MiB | Serialized (compact JSON, UTF-8) size of one query result. |

- Tools are listed once, when the port is created, following `nextCursor` for at most 100 pages. `tools/list_changed`
  is not followed: restart to refresh. There is no reconnection either: the caller owns the client and its lifetime.
- `onSkip` reports a listed tool left out: a name outside `[A-Za-z0-9_.-]{1,128}` (it must be usable verbatim as a
  `query://` path), or a duplicate. `include` runs first; a duplicated name is skipped (first wins), unless the copies
  disagree on read-only vs write, in which case every copy is dropped.
- Every `/binding/resolve` for a query calls the upstream tool: nothing is cached here.
- The calling principal is **not forwarded** to the MCP server: the client's transport authenticates once, so every
  caller shares that one upstream credential and there is no per-caller authorization upstream.
- Errors: `McpArgumentError` (code `MCP_ARGUMENT_INVALID`, a string that does not convert), `McpResultError` (not a list
  of rows, or over a limit), `McpToolError` (the tool reported `isError`; text truncated to 500 characters, no code),
  `McpTimeoutError`. Raised inside `DomainPort.invoke` for a read, the REST host reports all of them like any failed
  read: 404 `REF_NOT_FOUND` with the detail kept out of the body.
- No test in this package calls a real MCP server or LLM: the e2e test runs an in-process MCP server through
  `createKohakuHost` with a scripted `FakeLlm`.

The Python mirror is `kohaku.domain_mcp` (`pip install 'kohaku-ui[mcp]'`); the pure functions are pinned across the
two languages by the cross-language golden fixture.
