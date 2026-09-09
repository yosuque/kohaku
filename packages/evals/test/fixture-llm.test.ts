import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmError } from "@kohaku-ui/llm";
import { FakeLlm } from "@kohaku-ui/llm/fake";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { FixtureLlm } from "../src/fixture-llm.js";

/** Asserts a rejected promise is an LlmError with the given code. */
async function expectLlmError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(LlmError);
  try {
    await promise;
    expect.fail("expected promise to reject");
  } catch (e) {
    expect((e as LlmError).code).toBe(code);
  }
}

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-fixture-llm-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const SCHEMA = z.object({ foo: z.string() });

describe("FixtureLlm: record then replay", () => {
  it("record mode writes a fixture file, and replay returns an equal result without touching the live port", async () => {
    const dir = freshDir();
    const live = new FakeLlm({ objects: [{ foo: "bar" }] });
    const recorder = new FixtureLlm(dir, { record: true, live });

    const req = { schema: SCHEMA, schemaName: "s1", prompt: "hello" };
    const recorded = await recorder.generateObject(req);
    expect(recorded.object).toEqual({ foo: "bar" });
    expect(live.calls).toHaveLength(1);

    // A separate replay-only instance backed by the same fixture dir, with no live port at all.
    const replay = new FixtureLlm(dir);
    const replayed = await replay.generateObject(req);
    expect(replayed.object).toEqual({ foo: "bar" });
    // The live port was never invoked again (replay is served entirely from the fixture).
    expect(live.calls).toHaveLength(1);
  });
});

describe("FixtureLlm: corrupted or invalid fixtures", () => {
  it("a corrupted fixture file (invalid JSON) throws LlmError with code INVALID_OUTPUT", async () => {
    const dir = freshDir();
    const live = new FakeLlm({ objects: [{ foo: "bar" }] });
    const recorder = new FixtureLlm(dir, { record: true, live });
    const req = { schema: SCHEMA, schemaName: "s1", prompt: "hello" };
    await recorder.generateObject(req);

    // Corrupt the fixture file that was just written (the key is not exposed publicly, so locate the
    // single file FixtureLlm just wrote into the fixtures dir).
    const fileName = readdirSync(dir)[0]!;
    writeFileSync(join(dir, fileName), "{ this is not valid json");

    const replay = new FixtureLlm(dir);
    await expectLlmError(replay.generateObject(req), "INVALID_OUTPUT");
  });

  it("a fixture whose recorded content fails the zod schema throws LlmError with code INVALID_OUTPUT", async () => {
    const dir = freshDir();
    const live = new FakeLlm({ objects: [{ foo: "bar" }] });
    const recorder = new FixtureLlm(dir, { record: true, live });
    const req = { schema: SCHEMA, schemaName: "s1", prompt: "hello" };
    await recorder.generateObject(req);

    // Overwrite the recorded object with one that no longer matches SCHEMA (foo must be a string).
    const fileName = readdirSync(dir)[0]!;
    writeFileSync(join(dir, fileName), JSON.stringify({ object: { foo: 123 } }));

    const replay = new FixtureLlm(dir);
    await expectLlmError(replay.generateObject(req), "INVALID_OUTPUT");
  });
});

describe("FixtureLlm: replay mode with a missing fixture", () => {
  it("throws LlmError with code INVALID_OUTPUT when no fixture exists for the key", async () => {
    const dir = freshDir();
    const replay = new FixtureLlm(dir);
    await expectLlmError(
      replay.generateObject({ schema: SCHEMA, schemaName: "s1", prompt: "never recorded" }),
      "INVALID_OUTPUT",
    );
  });

  it("generateText also throws LlmError with code INVALID_OUTPUT when no fixture exists", async () => {
    const dir = freshDir();
    const replay = new FixtureLlm(dir);
    await expectLlmError(replay.generateText({ prompt: "never recorded" }), "INVALID_OUTPUT");
  });
});

describe("FixtureLlm: construction guard", () => {
  it("record: true without a live port throws LlmError with code CONFIG", () => {
    const dir = freshDir();
    expect(() => new FixtureLlm(dir, { record: true })).toThrow(LlmError);
    try {
      new FixtureLlm(dir, { record: true });
      expect.fail("expected construction to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      expect((e as LlmError).code).toBe("CONFIG");
    }
  });
});
