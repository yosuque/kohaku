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
import { coerceToolArguments } from "./coerce.js";
import { mcpDataVersion } from "./data-version.js";
import { projectInputSchema, type SchemaProjection } from "./schema-projection.js";
import { shapeFromOutputSchema } from "./shape.js";
import { assertToolSucceeded, payloadOf, toTabularData } from "./tabular.js";
import type { McpToolClientLike, McpToolInfo } from "./types.js";

/** The names an MCP tool may have (SEP-986), which is also what a `query://` path segment can carry verbatim. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/** A guard against a server that pages forever. */
const MAX_LIST_PAGES = 100;

export interface McpDomainPortOptions {
  /** The connected MCP client (`@modelcontextprotocol/client`'s `Client`, or anything with `listTools` / `callTool`). */
  client: McpToolClientLike;
  /** Which tools to expose at all (default: every listed tool). */
  include?: (tool: McpToolInfo) => boolean;
  /** Override the default tier (`"approve"`) of a non-read-only tool. Never consulted for a read-only tool. */
  tierFor?: (tool: McpToolInfo) => ActionTier;
  /**
   * The version stamped on every `TabularData` this port returns. Default `mcpDataVersion()` (5 minute buckets).
   * Pass the same function to the host's `dataVersion` (or read it back from `port.dataVersion`), so the Spec's
   * version and the data's version always agree.
   */
  dataVersion?: () => string;
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
  /** Called for a listed tool that is left out because its name is unusable or duplicated. */
  onSkip?: (report: { tool: string; reason: string }) => void;
}

export interface McpDomainPort extends DomainPort {
  /** Names of the read-only tools: the operations a `query://` ref can resolve to. */
  readonly queryOps: ReadonlySet<string>;
  /** Names of every other exposed tool: the governed Actions. */
  readonly actionOps: ReadonlySet<string>;
  /** Every exposed tool by name, as the server listed it (`createMcpIntents` builds Intent params from it). */
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

function isReadOnly(tool: McpToolInfo): boolean {
  // MCP's default for readOnlyHint is false, so only an explicit `true` makes a tool a query: a tool that says
  // nothing is a write, which is the safe side.
  return tool.annotations?.readOnlyHint === true;
}

function describeOperation(
  tool: McpToolInfo,
  projection: SchemaProjection,
  tier: ActionTier | undefined,
): OperationDescriptor {
  const resultShape = shapeFromOutputSchema(tool.outputSchema);
  return {
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
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
 * - A tool with `annotations.readOnlyHint === true` is a query: a `query://` ref whose path is the tool name
 *   resolves by calling it, and the result becomes `TabularData`. It carries no `tier`.
 * - Every other tool is an Action with `tier: "approve"` (override with `tierFor`). Its `paramsSchema` is the
 *   projection of its `inputSchema` onto kohaku's closed subset, or absent when that is impossible; the approver
 *   then judges the raw payload.
 * - The calling principal is not forwarded to the MCP server: authenticating to it is the client transport's job.
 */
export async function createMcpDomainPort(options: McpDomainPortOptions): Promise<McpDomainPort> {
  const { client } = options;
  const dataVersion = options.dataVersion ?? mcpDataVersion();
  const tools = new Map<string, McpToolInfo>();
  const operations: OperationDescriptor[] = [];
  const queryOps = new Set<string>();
  const actionOps = new Set<string>();

  for (const tool of await listAllTools(client)) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      options.onSkip?.({ tool: tool.name, reason: "the tool name is not usable as a query:// path segment" });
      continue;
    }
    if (tools.has(tool.name)) {
      options.onSkip?.({ tool: tool.name, reason: "a tool with this name was already listed" });
      continue;
    }
    if (options.include != null && !options.include(tool)) continue;

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
      queryOps.add(tool.name);
      operations.push(describeOperation(tool, projection, undefined));
    } else {
      actionOps.add(tool.name);
      operations.push(describeOperation(tool, projection, options.tierFor?.(tool) ?? "approve"));
    }
  }

  return {
    queryOps,
    actionOps,
    tools,
    dataVersion,
    async listOperations() {
      return operations;
    },
    async invoke(op: string, args: JsonObject, _ctx: InvocationContext): Promise<unknown> {
      const tool = tools.get(op);
      if (tool == null) throw new Error(`unknown operation "${op}"`);
      if (queryOps.has(op)) {
        const result = await client.callTool({
          name: op,
          arguments: coerceToolArguments(args, tool.inputSchema),
        });
        return toTabularData(result, dataVersion(), op);
      }
      const result = await client.callTool({ name: op, arguments: args });
      assertToolSucceeded(result, op);
      return actionResult(payloadOf(result));
    },
    describeShape(ref: QueryRef): DataShape | null {
      if (!queryOps.has(ref.path)) return null;
      return shapeFromOutputSchema(tools.get(ref.path)?.outputSchema);
    },
  };
}
