# @kohaku-ui/domain-mcp

Turns an existing MCP server into a kohaku `DomainPort`. Read-only tools become `query://` references; every
other tool becomes a governed Action with `tier: "approve"`.

```bash
npm install @kohaku-ui/domain-mcp @kohaku-ui/intents @kohaku-ui/spec-core zod
npm install @modelcontextprotocol/client   # to build the client you pass in
```

```ts
import { createMcpDomainPort, createMcpIntents } from "@kohaku-ui/domain-mcp";
import { createKohakuHost } from "@kohaku-ui/host";

const domain = await createMcpDomainPort({
  client, // a connected @modelcontextprotocol/client Client (anything with listTools / callTool works)
  onSchemaProjection: (report) => console.warn(report), // { tool, dropped, omitted, reasons }
});

const host = createKohakuHost({
  domain,
  querySource: "orders",
  llm,
  intents: createMcpIntents(domain, { source: "orders" }), // one Intent per read-only tool
  describeShape: (ref) => domain.describeShape(ref), // columns from the tool's outputSchema
  dataVersion: domain.dataVersion, // the function the port stamps on the data
  routes: { approvals, authorizeGovernance }, // required for the approve-tier writes to ever run
});
```

## What it does

- **Classification.** `annotations.readOnlyHint === true` makes a tool a query (`domain.queryOps`). Everything else,
  including a tool with no annotation (MCP's default is `false`), is an Action (`domain.actionOps`) with
  `tier: "approve"`; `tierFor(tool)` overrides that for non-read-only tools. `include(tool)` leaves tools out.
- **Queries.** `invoke` coerces the ref's string parameters by the tool's `inputSchema` type (`number`, `integer`,
  `boolean`; a nullable `anyOf` is read through), never forwards `_cursor` / `_sort` / `_dir`, maps `_limit` onto the
  tool's own `limit`, calls the tool, and converts the result to `TabularData`: `structuredContent`, else the first
  JSON text block, as an array, `{ rows: [...] }`, or an object with a single array property. Columns are inferred
  from the first 50 rows (`number` / `boolean` / `date` / `string`).
- **Actions.** The payload goes to the tool unchanged. Its `paramsSchema` is the tool's `inputSchema` *projected*
  onto kohaku's closed JSON Schema subset: annotations (`description`, `title`, `default`), `format` and `pattern`
  are dropped, and every object is closed with `additionalProperties: false`. A schema with `anyOf` / `oneOf` /
  `$ref`, a type array, `additionalProperties: true` or any other keyword is omitted entirely, so kohaku cannot
  validate that Action's payload and the approver judges the raw payload. Both outcomes are reported through
  `onSchemaProjection`.
- **Intents.** `createMcpIntents` makes an `IntentDef` per read-only tool (params from string / enum / number /
  integer properties; `onSkip` reports a tool that requires any other type). A write tool therefore never has an
  Intent, and a read capability is only ever issued for an Intent's resolved refs.
- **Data version.** MCP has none, so the port stamps `mcpDataVersion()` (`mcp:<floor(now / 300 s)>`) on the data,
  and `domain.dataVersion` is that same function, to hand to the host. Pass `dataVersion` to the port to use your own.
- **Shape.** `domain.describeShape(ref)` builds a `DataShape` from the tool's `outputSchema` (`string` is a
  dimension, `number` / `integer` a measure, `format: date | date-time` a time column), or `null`.

## Limits

- The tool list is read once, when the port is created. `tools/list_changed` is not followed: restart to refresh.
- The calling principal is not forwarded to the MCP server; the client's transport authenticates to it.
- `outputSchema` / `structuredContent` that is not a list of objects cannot be a query result.
- No test in this package calls a real MCP server or LLM: the e2e test runs an in-process MCP server through
  `createKohakuHost` with a scripted `FakeLlm`.

The Python mirror is `kohaku.domain_mcp` (`pip install 'kohaku-ui[mcp]'`); the pure functions are pinned across the
two languages by the cross-language golden fixture.
