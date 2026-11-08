import type { QueryRef } from "@kohaku-ui/data-binding";
import type {
  ActionTier,
  DataShape,
  DomainPort,
  InvocationContext,
  JsonObject,
  JsonValue,
  OperationDescriptor,
} from "@kohaku-ui/spec-core";
import { coerceToolArguments, DEFAULT_MAX_LIMIT } from "./coerce.js";
import { mcpDataVersion } from "./data-version.js";
import { droppedConstraints, projectInputSchema, type SchemaProjection } from "./schema-projection.js";
import { shapeFromOutputSchema } from "./shape.js";
import {
  assertToolSucceeded,
  DEFAULT_MAX_RESULT_BYTES,
  DEFAULT_MAX_ROWS,
  payloadOf,
  toTabularData,
} from "./tabular.js";
import type { McpCallResult, McpToolClientLike, McpToolInfo } from "./types.js";

/** The names an MCP tool may have (SEP-986), which is also what a `query://` path segment can carry verbatim. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** A guard against a server that pages forever. */
export const MAX_LIST_PAGES = 100;

/** Default deadline for one upstream `tools/call`. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** The SDK's own `timeout` is set this much later than ours, as a backstop that never wins the race. */
const SDK_TIMEOUT_MARGIN_MS = 5_000;

/** How many constraint names the approver-facing description lists before it says "…". */
const MAX_LISTED_CONSTRAINTS = 5;

/** The `code` of a write's `McpTimeoutError`: the tool may or may not have run (host-core's `isOutcomeUnknownError`). */
export const MCP_OUTCOME_UNKNOWN = "MCP_OUTCOME_UNKNOWN";

/**
 * An upstream call did not answer within `callTimeoutMs`. The request was aborted, not retried. For a write the
 * description says the effect is unknown (the tool may or may not have run) and the error carries the code
 * `MCP_OUTCOME_UNKNOWN`, which the hosts recognise: REST answers 503 `INTERNAL` with a fixed "outcome is unknown;
 * verify before retrying" message instead of the 404 every failed read gets, and MCP the same text as a tool error.
 * A read's timeout has no `code`: nothing was changed, so it stays an ordinary failed read.
 */
export class McpTimeoutError extends Error {
  readonly code: string | undefined;
  constructor(tool: string, write: boolean) {
    super(
      write
        ? `MCP tool "${tool}": the upstream tool did not answer in time; its effect is unknown`
        : `MCP tool "${tool}": the upstream tool did not answer in time`,
    );
    this.name = "McpTimeoutError";
    this.code = write ? MCP_OUTCOME_UNKNOWN : undefined;
  }
}

export interface McpDomainPortOptions {
  /** The connected MCP client (`@modelcontextprotocol/client`'s `Client`, or anything with `listTools` / `callTool`). */
  client: McpToolClientLike;
  /** Which tools to expose at all (default: every listed tool). Applied before name and duplicate checks. */
  include?: (tool: McpToolInfo) => boolean;
  /**
   * Whether a tool is a read-only query (default: `tool.annotations?.readOnlyHint === true`). **`readOnlyHint` is a
   * hint from the server, not a guarantee**: a server that marks a write tool read-only bypasses the approve
   * gate. Use this adapter only with MCP servers you trust, or classify the tools yourself here (and `include`).
   */
  isReadOnly?: (tool: McpToolInfo) => boolean;
  /** Override the default tier (`"approve"`) of a non-read-only tool. Never consulted for a read-only tool. */
  tierFor?: (tool: McpToolInfo) => ActionTier;
  /**
   * The version stamped on every `TabularData` this port returns. Default `mcpDataVersion()` (5 minute buckets).
   * Pass the same function to the host's `dataVersion` (or read it back from `port.dataVersion`). Even then a Spec
   * composed just before a bucket boundary is stale once after it, and a successful write does not change the
   * version until the next bucket.
   */
  dataVersion?: () => string;
  /** Deadline for one upstream `tools/call`, in milliseconds (default 30000). Never retried automatically. */
  callTimeoutMs?: number;
  /** Ceiling for the tool's numeric `limit` argument, however it was supplied (default 1000). */
  maxLimit?: number;
  /** Maximum rows of one query result (default 10000); more is an error. */
  maxRows?: number;
  /** Maximum serialized bytes of one query result (default 10 MiB); more is an error. */
  maxResultBytes?: number;
  /**
   * Called once per exposed tool whose `inputSchema` lost something in the projection onto kohaku's closed
   * `paramsSchema` subset (`dropped` keywords), or could not be projected at all (`omitted`, with `reasons`).
   * Not called when the projection was lossless.
   */
  onSchemaProjection?: (report: {
    tool: string;
    dropped: string[];
    omitted: boolean;
    reasons: string[];
  }) => void;
  /** Called for a listed tool that is left out: an unusable name, or a duplicated one. */
  onSkip?: (report: { tool: string; reason: string }) => void;
}

export interface McpDomainPort extends DomainPort {
  /** Names of the read-only tools: the operations a `query://` ref can resolve to. A copy on every access. */
  readonly queryOps: ReadonlySet<string>;
  /** Names of every other exposed tool: the governed Actions. A copy on every access. */
  readonly actionOps: ReadonlySet<string>;
  /** Every exposed tool by name, as the server listed it (`createMcpIntents` builds Intent params from it). A copy. */
  readonly tools: ReadonlyMap<string, McpToolInfo>;
  /** The version stamped on returned data (see `McpDomainPortOptions.dataVersion`). */
  readonly dataVersion: () => string;
  /** The column shape of a query op, from its tool's `outputSchema`; null when it has none or is not a query. */
  describeShape(ref: QueryRef): DataShape | null;
}

async function listAllTools(client: McpToolClientLike): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await client.listTools(cursor == null ? undefined : { cursor });
    tools.push(...result.tools);
    if (result.nextCursor == null || result.nextCursor === "") return tools;
    cursor = result.nextCursor;
  }
  throw new Error(`createMcpDomainPort: the server's tool list did not end after ${MAX_LIST_PAGES} pages`);
}

function defaultIsReadOnly(tool: McpToolInfo): boolean {
  // MCP's default for readOnlyHint is false, so only an explicit `true` makes a tool a query: a tool that says
  // nothing is a write, which is the safe side.
  return tool.annotations?.readOnlyHint === true;
}

/** The approver-facing description, with a note when the projection loosened or dropped the payload check. */
function describeAction(tool: McpToolInfo, projection: SchemaProjection): string {
  const base = tool.description ?? tool.title ?? tool.name;
  if (projection.omitted) return `${base} (parameter schema omitted: the payload is not validated)`;
  const { count, keywords } = droppedConstraints(projection.dropped);
  if (count === 0) return base;
  const listed = keywords.slice(0, MAX_LISTED_CONSTRAINTS).join(", ");
  const more = keywords.length > MAX_LISTED_CONSTRAINTS ? ", …" : "";
  return `${base} (${count} schema constraint${count === 1 ? "" : "s"} omitted: ${listed}${more})`;
}

function describeOperation(
  tool: McpToolInfo,
  projection: SchemaProjection,
  tier: ActionTier | undefined,
): OperationDescriptor {
  const resultShape = shapeFromOutputSchema(tool.outputSchema);
  return {
    name: tool.name,
    description:
      tier === undefined ? (tool.description ?? tool.title ?? tool.name) : describeAction(tool, projection),
    ...(projection.schema != null ? { paramsSchema: projection.schema } : {}),
    ...(resultShape != null ? { resultShape } : {}),
    ...(tier != null ? { tier } : {}),
  };
}

/** The result of an Action as the JSON object `DomainPort.invoke` hands back to the host. */
function actionResult(payload: unknown): JsonValue {
  if (payload === undefined) return { ok: true };
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload))
    return payload as JsonObject;
  return { result: payload as JsonValue };
}

/**
 * Builds a kohaku `DomainPort` over an existing MCP server. The tool list is read once, here (a later
 * `tools/list_changed` is not followed: restart the host to pick up a new tool).
 *
 * - A tool with `annotations.readOnlyHint === true` (or whatever `isReadOnly` says) is a query: a `query://` ref
 *   whose path is the tool name resolves by calling it, and the result becomes `TabularData`. It carries no `tier`.
 * - Every other tool is an Action with `tier: "approve"` (override with `tierFor`). Its `paramsSchema` is the
 *   projection of its `inputSchema` onto kohaku's closed subset, or absent when that is impossible; the approver
 *   then judges the raw payload, and the description says so.
 * - The calling principal is not forwarded to the MCP server: authenticating to it is the client transport's job,
 *   so every caller shares one upstream credential.
 * - A duplicated tool name is skipped (the first wins) unless the copies disagree on read-only vs write, in which
 *   case every copy is dropped (fail closed).
 */
export async function createMcpDomainPort(options: McpDomainPortOptions): Promise<McpDomainPort> {
  const { client } = options;
  const dataVersion = options.dataVersion ?? mcpDataVersion();
  const isReadOnly = options.isReadOnly ?? defaultIsReadOnly;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs <= 0) {
    throw new Error(`createMcpDomainPort: callTimeoutMs must be a positive number, got ${callTimeoutMs}`);
  }
  const maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT;
  const limits = {
    maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
    maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
  };

  const listed = await listAllTools(client);
  // `include` and the name check come first, so a tool the caller left out never counts as a duplicate.
  const candidates = listed.filter(
    (tool) => TOOL_NAME_PATTERN.test(tool.name) && (options.include?.(tool) ?? true),
  );
  const classes = new Map<string, Set<boolean>>();
  for (const tool of candidates) {
    const set = classes.get(tool.name) ?? new Set<boolean>();
    set.add(isReadOnly(tool));
    classes.set(tool.name, set);
  }

  const tools = new Map<string, McpToolInfo>();
  const operations: OperationDescriptor[] = [];
  const queryNames = new Set<string>();
  const actionNames = new Set<string>();

  for (const tool of listed) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      options.onSkip?.({ tool: tool.name, reason: "the tool name is not usable as a query:// path segment" });
      continue;
    }
    if (options.include != null && !options.include(tool)) continue;
    if ((classes.get(tool.name)?.size ?? 0) > 1) {
      options.onSkip?.({
        tool: tool.name,
        reason: "several tools share this name and disagree on whether it is read-only; all were dropped",
      });
      continue;
    }
    if (tools.has(tool.name)) {
      options.onSkip?.({ tool: tool.name, reason: "a tool with this name was already listed" });
      continue;
    }

    const projection = projectInputSchema(tool.inputSchema);
    if (options.onSchemaProjection != null && (projection.omitted || projection.dropped.length > 0)) {
      options.onSchemaProjection({
        tool: tool.name,
        dropped: projection.dropped,
        omitted: projection.omitted,
        reasons: projection.reasons,
      });
    }
    tools.set(tool.name, tool);
    if (isReadOnly(tool)) {
      queryNames.add(tool.name);
      operations.push(describeOperation(tool, projection, undefined));
    } else {
      actionNames.add(tool.name);
      operations.push(describeOperation(tool, projection, options.tierFor?.(tool) ?? "approve"));
    }
  }

  /** One upstream call with a deadline: aborts the request and never retries. */
  async function call(name: string, args: Record<string, unknown>, write: boolean): Promise<McpCallResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new McpTimeoutError(name, write));
      }, callTimeoutMs);
    });
    try {
      return await Promise.race([
        client.callTool(
          { name, arguments: args },
          { signal: controller.signal, timeout: callTimeoutMs + SDK_TIMEOUT_MARGIN_MS },
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get queryOps() {
      return new Set(queryNames);
    },
    get actionOps() {
      return new Set(actionNames);
    },
    get tools() {
      return new Map(tools);
    },
    dataVersion,
    async listOperations() {
      return operations.map((op) => ({ ...op }));
    },
    async invoke(op: string, args: JsonObject, _ctx: InvocationContext): Promise<unknown> {
      const tool = tools.get(op);
      if (tool == null) throw new Error(`unknown operation "${op}"`);
      if (queryNames.has(op)) {
        const result = await call(op, coerceToolArguments(args, tool.inputSchema, { maxLimit }), false);
        return toTabularData(result, dataVersion(), op, limits);
      }
      const result = await call(op, args, true);
      assertToolSucceeded(result, op);
      return actionResult(payloadOf(result));
    },
    describeShape(ref: QueryRef): DataShape | null {
      if (!queryNames.has(ref.path)) return null;
      return shapeFromOutputSchema(tools.get(ref.path)?.outputSchema);
    },
  };
}
