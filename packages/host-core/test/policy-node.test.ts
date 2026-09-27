import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicyFile } from "../src/policy-node.js";

describe("loadPolicyFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kohaku-policy-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads, parses, and validates a policy file from disk", async () => {
    const path = join(dir, "kohaku.policy.json");
    await writeFile(path, JSON.stringify({ version: 1, defaults: { compose: { allowL2: true } } }), "utf8");
    const parsed = await loadPolicyFile(path);
    expect(parsed.file.defaults.compose?.allowL2).toBe(true);
    expect(parsed.policyId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects a file that fails schema validation (unknown key)", async () => {
    const path = join(dir, "bad.policy.json");
    await writeFile(path, JSON.stringify({ version: 1, defaults: {}, bogus: true }), "utf8");
    await expect(loadPolicyFile(path)).rejects.toThrow();
  });

  it("rejects non-JSON content", async () => {
    const path = join(dir, "not-json.policy.json");
    await writeFile(path, "not json at all", "utf8");
    await expect(loadPolicyFile(path)).rejects.toThrow();
  });

  it("rejects a missing file", async () => {
    await expect(loadPolicyFile(join(dir, "missing.json"))).rejects.toThrow();
  });
});
