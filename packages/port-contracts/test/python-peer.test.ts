import { describe, expect, it } from "vitest";
import { resolvePythonPeer } from "../src/python-peer.js";

describe("resolvePythonPeer", () => {
  const root = "/repo";
  const venvPython = "/repo/python/.venv/bin/python";
  const script = "/repo/python/kohaku/tests/storage/interop_peer.py";

  it("uses the workspace venv's interpreter and the peer script when both exist", () => {
    const peer = resolvePythonPeer({}, root, (path) => path === venvPython || path === script);
    expect(peer).toEqual({ mode: "run", python: venvPython, script });
  });

  it("prefers KOHAKU_PYTHON over the venv", () => {
    const peer = resolvePythonPeer(
      { KOHAKU_PYTHON: "/opt/py/bin/python" },
      root,
      (path) => path === "/opt/py/bin/python" || path === script,
    );
    expect(peer).toEqual({ mode: "run", python: "/opt/py/bin/python", script });
  });

  it("skips, naming how to get the interpreter, when it does not exist", () => {
    const peer = resolvePythonPeer({}, root, () => false);
    expect(peer.mode).toBe("skip");
    if (peer.mode === "skip") expect(peer.reason).toContain("uv sync");
  });

  it("throws instead of skipping when KOHAKU_ADAPTER_TESTS=require", () => {
    expect(() => resolvePythonPeer({ KOHAKU_ADAPTER_TESTS: "require" }, root, () => false)).toThrow(
      /KOHAKU_ADAPTER_TESTS=require/,
    );
  });
});
