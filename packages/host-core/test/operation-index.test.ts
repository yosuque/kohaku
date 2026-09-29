import type { DomainPort } from "@kohaku-ui/spec-core";
import { ActionParamsSchemaError } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createOperationIndex, validateOperationIndex } from "../src/operation-index.js";

const NOTE_SCHEMA = {
  type: "object",
  properties: { note: { type: "string", maxLength: 500 } },
  required: ["note"],
  additionalProperties: false,
};

describe("createOperationIndex", () => {
  it("memoizes listOperations() across calls, keyed by operation name", async () => {
    let calls = 0;
    const domain: DomainPort = {
      async listOperations() {
        calls++;
        return [
          { name: "annotate", description: "d", paramsSchema: NOTE_SCHEMA, tier: "confirm" },
          { name: "publish", description: "d" },
        ];
      },
      async invoke() {
        return null;
      },
    };
    const index = createOperationIndex(domain);
    const a = await index();
    const b = await index();
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect([...a.keys()]).toEqual(["annotate", "publish"]);
    expect(a.get("annotate")?.descriptor.tier).toBe("confirm");
    expect(a.get("annotate")?.paramsSchema).toEqual(NOTE_SCHEMA);
    expect(a.get("publish")?.paramsSchema).toBeUndefined();
  });

  it("confines a bad paramsSchema to its own operation: kept in the index with schemaError set", async () => {
    const domain: DomainPort = {
      async listOperations() {
        return [
          { name: "annotate", description: "d", paramsSchema: { type: "string", pattern: "^a+$" } },
          { name: "publish", description: "d", paramsSchema: NOTE_SCHEMA },
        ];
      },
      async invoke() {
        return null;
      },
    };
    const index = await createOperationIndex(domain)();
    expect([...index.keys()]).toEqual(["annotate", "publish"]);
    expect(index.get("annotate")?.schemaError).toBeInstanceOf(ActionParamsSchemaError);
    expect(index.get("annotate")?.paramsSchema).toBeUndefined();
    expect(index.get("publish")?.schemaError).toBeUndefined();
    expect(index.get("publish")?.paramsSchema).toEqual(NOTE_SCHEMA);
  });

  describe("validateOperationIndex", () => {
    it("reports each operation's schema error and a build failure, and never rejects", async () => {
      const bad = { type: "string", pattern: "x" };
      const seen: unknown[] = [];
      await validateOperationIndex(
        createOperationIndex({
          async listOperations() {
            return [
              { name: "a", description: "d", paramsSchema: bad },
              { name: "b", description: "d", paramsSchema: bad },
              { name: "c", description: "d" },
            ];
          },
          async invoke() {
            return null;
          },
        }),
        (e) => void seen.push(e),
      );
      expect(seen).toHaveLength(2);
      expect(seen.every((e) => e instanceof ActionParamsSchemaError)).toBe(true);

      const failing: unknown[] = [];
      await validateOperationIndex(
        createOperationIndex({
          async listOperations() {
            throw new Error("down");
          },
          async invoke() {
            return null;
          },
        }),
        (e) => void failing.push(e),
      );
      expect(failing).toHaveLength(1);
    });
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
    const index = createOperationIndex(domain, (e) => seen.push(e));
    await expect(index()).rejects.toThrow("domain unavailable");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toHaveLength(1);
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
    const index = createOperationIndex(domain);
    await expect(index()).rejects.toThrow("transient");
    expect(calls).toBe(1);
    const retried = await index();
    expect(calls).toBe(2);
    expect([...retried.keys()]).toEqual(["annotate"]);
  });
});
