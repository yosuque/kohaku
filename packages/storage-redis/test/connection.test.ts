import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createRedisConnection } from "../src/connection.js";

// A fully mocked `ioredis`: `createRedisConnection` is the single place the owned-client construction
// (timeouts, the `error` listener) and the `ready()` / `close()` lifecycle live, so both are unit-tested
// here once against a fake client rather than duplicated per adapter (storage port / revocation store).
// `vi.mock` is hoisted above these imports by vitest's transform, so `createRedisConnection`'s own
// `import { Redis } from "ioredis"` resolves to the fake below. `redisInstances` is declared via
// `vi.hoisted` (not a plain top-level `const`) because the factory below is hoisted with it: a factory
// that closed over an ordinary import/const instead would read it before its initializer ever ran.
interface FakeRedis extends EventEmitter {
  options: unknown;
  status: string;
  connect: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
const redisInstances: FakeRedis[] = vi.hoisted(() => []);

vi.mock("ioredis", async () => {
  // A dynamic import here (rather than a top-level `import { EventEmitter } from "node:events"` closed
  // over by this factory) sidesteps the same hoisting hazard `vi.hoisted` solves for `redisInstances`:
  // this factory itself runs at the hoisted `vi.mock` position, before the module's own top-level
  // imports are bound.
  const { EventEmitter: FakeEventEmitter } = await import("node:events");
  class FakeRedisCtor extends FakeEventEmitter {
    options: unknown;
    status = "wait";
    connect = vi.fn().mockResolvedValue(undefined);
    quit = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    constructor(_url: string, options: unknown) {
      super();
      this.options = options;
      redisInstances.push(this as unknown as FakeRedis);
    }
  }
  return { Redis: FakeRedisCtor };
});

function injectedClient(): FakeRedis {
  const emitter = new EventEmitter() as unknown as FakeRedis;
  emitter.status = "ready";
  emitter.options = undefined;
  emitter.connect = vi.fn();
  emitter.quit = vi.fn().mockResolvedValue(undefined);
  emitter.disconnect = vi.fn();
  return emitter;
}

describe("createRedisConnection: option validation", () => {
  it("rejects passing both url and client", () => {
    expect(() =>
      createRedisConnection({ url: "redis://x", client: injectedClient() as never }, "test"),
    ).toThrow(/pass either `url` or `client`, not both/);
  });

  it("rejects passing neither url nor client", () => {
    expect(() => createRedisConnection({}, "test")).toThrow(/one of `url` or `client` is required/);
  });
});

describe("createRedisConnection: owned client construction", () => {
  it("passes connect/command timeouts and maxRetriesPerRequest through to the Redis constructor", () => {
    redisInstances.length = 0;
    createRedisConnection(
      {
        url: "redis://example/0",
        connectTimeoutMs: 1234,
        commandTimeoutMs: 5678,
        maxRetriesPerRequest: 9,
      },
      "test",
    );
    expect(redisInstances).toHaveLength(1);
    expect(redisInstances[0]?.options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1234,
      commandTimeout: 5678,
      maxRetriesPerRequest: 9,
    });
  });

  it("applies the documented defaults when timeouts/maxRetriesPerRequest are omitted", () => {
    redisInstances.length = 0;
    createRedisConnection({ url: "redis://example/0" }, "test");
    expect(redisInstances[0]?.options).toMatchObject({
      connectTimeout: 5000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 3,
    });
  });

  it("attaches an error listener to an owned client and forwards it to onError", () => {
    redisInstances.length = 0;
    const onError = vi.fn();
    createRedisConnection({ url: "redis://example/0", onError }, "test");
    const boom = new Error("boom");
    redisInstances[0]!.emit("error", boom);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("logs via console.error (naming the label) when no onError is given", () => {
    redisInstances.length = 0;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      createRedisConnection({ url: "redis://example/0" }, "test label");
      const boom = new Error("boom");
      redisInstances[0]!.emit("error", boom);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("test label"), boom);
    } finally {
      spy.mockRestore();
    }
  });

  it("never constructs a client, attaches a listener, or touches an injected client's lifecycle", async () => {
    redisInstances.length = 0;
    const injected = injectedClient();
    const handle = createRedisConnection({ client: injected as never }, "test");
    expect(redisInstances).toHaveLength(0);
    expect(injected.listenerCount("error")).toBe(0);
    await handle.close();
    expect(injected.quit).not.toHaveBeenCalled();
    expect(injected.disconnect).not.toHaveBeenCalled();
  });

  it("close() quits an owned client", async () => {
    redisInstances.length = 0;
    const handle = createRedisConnection({ url: "redis://example/0" }, "test");
    await handle.close();
    expect(redisInstances[0]!.quit).toHaveBeenCalledTimes(1);
  });

  it("close() falls back to disconnect() when quit() rejects", async () => {
    redisInstances.length = 0;
    const handle = createRedisConnection({ url: "redis://example/0" }, "test");
    redisInstances[0]!.quit.mockRejectedValueOnce(new Error("not writable"));
    await handle.close();
    expect(redisInstances[0]!.disconnect).toHaveBeenCalledTimes(1);
  });
});
