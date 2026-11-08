import { describe, expect, it } from "vitest";
import {
  createMcpDomainPort,
  MCP_OUTCOME_UNKNOWN,
  McpOutcomeUnknownError,
  McpTimeoutError,
} from "../src/port.js";
import type { McpCallResult, McpToolClientLike } from "../src/types.js";
import { LIST_ORDERS, REFUND_ORDER } from "./fake-client.js";

const CTX = { principal: { id: "u1" } };

/** A client whose callTool throws (or rejects with) `error`; `sync` throws before returning a promise. */
function failing(error: unknown, options: { sync?: boolean } = {}): McpToolClientLike {
  return {
    async listTools() {
      return { tools: [LIST_ORDERS, REFUND_ORDER] };
    },
    callTool(): Promise<McpCallResult> {
      if (options.sync === true) throw error;
      return Promise.reject(error);
    },
  };
}

function sdkError(code: string, message = "sdk"): Error {
  return Object.assign(new Error(message), { name: "SdkError", code });
}

function rpcError(code: number, message = "rpc"): Error {
  return Object.assign(new Error(message), { name: "ProtocolError", code });
}

async function write(client: McpToolClientLike) {
  const port = await createMcpDomainPort({ client, callTimeoutMs: 1000 });
  return port.invoke("refund_order", { orderId: "o-1" }, CTX).catch((e: unknown) => e);
}

describe("a write that fails after the request may have left", () => {
  it.each([["CONNECTION_CLOSED"], ["SEND_FAILED"], ["REQUEST_TIMEOUT"], ["INVALID_RESULT"]])(
    "wraps an SdkError %s as MCP_OUTCOME_UNKNOWN with the original as cause",
    async (code) => {
      const original = sdkError(code, "Connection closed");
      const failure = await write(failing(original));
      expect(failure).toBeInstanceOf(McpOutcomeUnknownError);
      expect((failure as McpOutcomeUnknownError).code).toBe(MCP_OUTCOME_UNKNOWN);
      expect((failure as Error).cause).toBe(original);
      // The SDK's own wording is for the operator (onError), not the message of the wrapper.
      expect((failure as Error).message).not.toContain("Connection closed");
    },
  );

  it("wraps a fetch TypeError, an ECONNRESET and a plain Error, also when thrown synchronously", async () => {
    for (const original of [
      new TypeError("fetch failed"),
      Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      new Error("boom"),
    ]) {
      for (const sync of [false, true]) {
        const failure = await write(failing(original, { sync }));
        expect(failure).toBeInstanceOf(McpOutcomeUnknownError);
        expect((failure as Error).cause).toBe(original);
      }
    }
  });

  it("re-throws a JSON-RPC error the server answered unchanged (the tool did not run)", async () => {
    const original = rpcError(-32602, "Invalid params");
    expect(await write(failing(original))).toBe(original);
  });

  it.each([
    ["NOT_CONNECTED"],
    ["ALREADY_CONNECTED"],
    ["NOT_INITIALIZED"],
    ["CAPABILITY_NOT_SUPPORTED"],
    ["METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION"],
  ])("re-throws a pre-send SdkError %s unchanged", async (code) => {
    const original = sdkError(code);
    expect(await write(failing(original))).toBe(original);
  });

  it("leaves a read's failure alone: nothing was changed, so there is no unknown outcome", async () => {
    const original = sdkError("CONNECTION_CLOSED");
    const port = await createMcpDomainPort({ client: failing(original), callTimeoutMs: 1000 });
    expect(await port.invoke("list_orders", {}, CTX).catch((e: unknown) => e)).toBe(original);
  });
});

describe("the deadline against a client whose abort rejects", () => {
  function hanging(sync: boolean): McpToolClientLike {
    const hang = (signal?: AbortSignal) =>
      new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
      });
    return {
      async listTools() {
        return { tools: [LIST_ORDERS, REFUND_ORDER] };
      },
      callTool: sync
        ? (_params, options) => hang(options?.signal)
        : async (_params, options) => hang(options?.signal),
    };
  }

  it.each([[true], [false]])(
    "a write timeout is an McpTimeoutError whatever the client rejects with (sync=%s)",
    async (sync) => {
      const port = await createMcpDomainPort({ client: hanging(sync), callTimeoutMs: 20 });
      const failure = await port.invoke("refund_order", { orderId: "o-1" }, CTX).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(McpTimeoutError);
      expect((failure as McpTimeoutError).code).toBe(MCP_OUTCOME_UNKNOWN);
    },
  );

  it.each([[true], [false]])(
    "a read timeout is an McpTimeoutError without a code (sync=%s)",
    async (sync) => {
      const port = await createMcpDomainPort({ client: hanging(sync), callTimeoutMs: 20 });
      const failure = await port.invoke("list_orders", {}, CTX).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(McpTimeoutError);
      expect((failure as McpTimeoutError).code).toBeUndefined();
    },
  );

  it("a failure that arrives after the deadline on a write is still outcome-unknown", async () => {
    // The client ignores the signal and rejects a little later with a transport error.
    const slow: McpToolClientLike = {
      async listTools() {
        return { tools: [REFUND_ORDER] };
      },
      callTool: () => new Promise((_, reject) => setTimeout(() => reject(new TypeError("fetch failed")), 60)),
    };
    const port = await createMcpDomainPort({ client: slow, callTimeoutMs: 20 });
    const failure = await port.invoke("refund_order", { orderId: "o-1" }, CTX).catch((e: unknown) => e);
    expect((failure as { code?: string }).code).toBe(MCP_OUTCOME_UNKNOWN);
  });
});
