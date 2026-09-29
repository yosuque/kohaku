import type { DomainPort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { allowedActionsFromIndex, createAllowedActions } from "../src/allowed-actions.js";
import { createOperationIndex } from "../src/operation-index.js";

describe("createAllowedActions", () => {
  it("memoizes listOperations() across calls", async () => {
    let calls = 0;
    const domain: DomainPort = {
      async listOperations() {
        calls++;
        return [
          { name: "annotate", description: "d" },
          { name: "publish", description: "d" },
        ];
      },
      async invoke() {
        return null;
      },
    };
    const allowedActions = createAllowedActions(domain);
    const a = await allowedActions();
    const b = await allowedActions();
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect([...a]).toEqual(["annotate", "publish"]);
  });

  it("propagates a listOperations() rejection to the caller and notifies the optional onError hook", async () => {
    const domain: DomainPort = {
      async listOperations() {
        throw new Error("domain unavailable");
      },
      async invoke() {
        return null;
      },
    };
    const seen: unknown[] = [];
    const allowedActions = createAllowedActions(domain, (e) => seen.push(e));
    await expect(allowedActions()).rejects.toThrow("domain unavailable");
    // onError is fire-and-forget; give its microtask a tick to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe("domain unavailable");
  });

  it("discards the cached rejection so the next call retries against the DomainPort", async () => {
    let calls = 0;
    const domain: DomainPort = {
      async listOperations() {
        calls++;
        if (calls === 1) throw new Error("transient");
        return [{ name: "annotate", description: "d" }];
      },
      async invoke() {
        return null;
      },
    };
    const allowedActions = createAllowedActions(domain);
    await expect(allowedActions()).rejects.toThrow("transient");
    expect(calls).toBe(1);
    const retried = await allowedActions();
    expect(calls).toBe(2);
    expect([...retried]).toEqual(["annotate"]);
  });
});

describe("allowedActionsFromIndex", () => {
  const domainOf = (ops: string[], counter: { calls: number }): DomainPort => ({
    async listOperations() {
      counter.calls++;
      return ops.map((name) => ({ name, description: "d" }));
    },
    async invoke() {
      return null;
    },
  });

  it("yields the index's action names without a second listOperations() call", async () => {
    const counter = { calls: 0 };
    const index = createOperationIndex(domainOf(["annotate", "publish"], counter));
    const allowed = allowedActionsFromIndex(index);
    expect([...(await allowed())]).toEqual(["annotate", "publish"]);
    await index();
    await allowed();
    expect(counter.calls).toBe(1);
  });

  it("keeps an operation whose paramsSchema is invalid (a bad schema never changes the set), and propagates a listOperations() rejection", async () => {
    let fail = true;
    const domain: DomainPort = {
      async listOperations() {
        if (fail) throw new Error("down");
        return [
          { name: "annotate", description: "d", paramsSchema: { type: "string", pattern: "x" } as never },
          { name: "publish", description: "d" },
        ];
      },
      async invoke() {
        return null;
      },
    };
    const allowed = allowedActionsFromIndex(createOperationIndex(domain));
    await expect(allowed()).rejects.toThrow("down");
    fail = false;
    expect([...(await allowed())]).toEqual(["annotate", "publish"]);
  });
});
