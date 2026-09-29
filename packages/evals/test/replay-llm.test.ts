import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { LlmError, type LlmPort } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { objectFixtureKey, textFixtureKey } from "../src/fixture-key.js";
import { FixtureLlm } from "../src/fixture-llm.js";
import { ReplayLlm } from "../src/replay-llm.js";

/** Asserts a rejected promise is an LlmError with the given code. */
async function expectLlmError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.fail("expected promise to reject");
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    expect((e as LlmError).code).toBe(code);
  }
}

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-replay-llm-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SCHEMA = z.object({ foo: z.string() });

describe("ReplayLlm: shares FixtureLlm's key function", () => {
  it("a fixture recorded by FixtureLlm replays under the same key via ReplayLlm's Record form", async () => {
    const dir = freshDir();
    const live = new FakeLlm({ objects: [{ foo: "bar" }] });
    const recorder = new FixtureLlm(dir, { record: true, live });
    const req = { schema: SCHEMA, schemaName: "s1", prompt: "hello" };
    await recorder.generateObject(req);

    // Read back the exact file FixtureLlm just wrote (filename = key) and bundle it into a Record, the
    // shape the playground's fixture-recording script would produce for the browser.
    const fileName = readdirSync(dir)[0]!;
    const key = basename(fileName, ".json");
    const recorded = JSON.parse(readFileSync(join(dir, fileName), "utf8")) as { object: unknown };

    // Independently verify the key matches what the shared key function derives for this request.
    expect(await objectFixtureKey(req)).toBe(key);

    const replay = new ReplayLlm({ [key]: { object: recorded.object } });
    const result = await replay.generateObject(req);
    expect(result.object).toEqual({ foo: "bar" });
  });

  it("the array constructor form ({ key, ...response }[]) is equivalent to the Record form", async () => {
    const req = { schema: SCHEMA, schemaName: "s1", prompt: "hello" };
    const key = await objectFixtureKey(req);
    const replay = new ReplayLlm([{ key, object: { foo: "bar" } }]);
    const result = await replay.generateObject(req);
    expect(result.object).toEqual({ foo: "bar" });
  });

  it("generateText uses textFixtureKey and returns the recorded text", async () => {
    const req = { prompt: "hello there" };
    const key = await textFixtureKey(req);
    const replay = new ReplayLlm({ [key]: { text: "hi" } });
    const result = await replay.generateText(req);
    expect(result.text).toBe("hi");
  });
});

describe("ReplayLlm: schema validation", () => {
  it("a recorded response that fails the zod schema throws LlmError with code INVALID_OUTPUT", async () => {
    const req = { schema: SCHEMA, schemaName: "s1", prompt: "hello" };
    const key = await objectFixtureKey(req);
    const replay = new ReplayLlm({ [key]: { object: { foo: 123 } } });
    await expectLlmError(replay.generateObject(req), "INVALID_OUTPUT");
  });
});

describe("ReplayLlm: missing fixture", () => {
  it("generateObject throws LlmError with code INVALID_OUTPUT and the key in the message", async () => {
    const req = { schema: SCHEMA, schemaName: "s1", prompt: "never recorded" };
    const key = await objectFixtureKey(req);
    const replay = new ReplayLlm({});
    try {
      await replay.generateObject(req);
      expect.fail("expected generateObject to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      expect((e as LlmError).code).toBe("INVALID_OUTPUT");
      expect((e as LlmError).message).toContain(key);
    }
  });

  it("generateText throws LlmError with code INVALID_OUTPUT when no fixture exists", async () => {
    const replay = new ReplayLlm({});
    await expectLlmError(replay.generateText({ prompt: "never recorded" }), "INVALID_OUTPUT");
  });

  it("looking up a generateText key against an object-only fixture set misses (kinds do not cross over)", async () => {
    const objReq = { schema: SCHEMA, schemaName: "s1", prompt: "same text" };
    const key = await objectFixtureKey(objReq);
    const replay = new ReplayLlm({ [key]: { object: { foo: "bar" } } });
    await expectLlmError(replay.generateText({ prompt: "same text" }), "INVALID_OUTPUT");
  });
});

describe("ReplayLlm: LlmPort surface", () => {
  it("does not implement streamObject (callers fall back to generateObject, matching FixtureLlm)", () => {
    const replay: LlmPort = new ReplayLlm({});
    expect(replay.streamObject).toBeUndefined();
  });

  it('defaults provider/modelId to "replay" and accepts overrides', () => {
    expect(new ReplayLlm({}).provider).toBe("replay");
    expect(new ReplayLlm({}).modelId).toBe("replay");
    const custom = new ReplayLlm({}, { provider: "p", modelId: "m" });
    expect(custom.provider).toBe("p");
    expect(custom.modelId).toBe("m");
  });
});
