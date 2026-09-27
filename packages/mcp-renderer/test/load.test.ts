/**
 * loadRendererHtml is mocked at the node:fs/promises boundary (not by writing/deleting a real
 * dist/renderer.html): the module-level cache means each scenario needs a fresh module instance, so every
 * test re-imports after vi.resetModules() rather than fighting shared state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ readFile }));

describe("loadRendererHtml", () => {
  afterEach(() => {
    vi.resetModules();
    readFile.mockReset();
  });

  it("throws an actionable error when dist/renderer.html has not been built", async () => {
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const { loadRendererHtml } = await import("../src/index.js");
    await expect(loadRendererHtml()).rejects.toThrow(/pnpm --filter @kohaku-ui\/mcp-renderer run build/);
  });

  it("resolves with the built bundle's contents", async () => {
    readFile.mockResolvedValue("<html>renderer</html>");
    const { loadRendererHtml } = await import("../src/index.js");
    await expect(loadRendererHtml()).resolves.toBe("<html>renderer</html>");
  });

  it("memoizes a successful read (readFile is called at most once)", async () => {
    readFile.mockResolvedValue("<html>renderer</html>");
    const { loadRendererHtml } = await import("../src/index.js");
    await loadRendererHtml();
    await loadRendererHtml();
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read (a later successful build is picked up)", async () => {
    readFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    readFile.mockResolvedValueOnce("<html>renderer</html>");
    const { loadRendererHtml } = await import("../src/index.js");
    await expect(loadRendererHtml()).rejects.toThrow();
    await expect(loadRendererHtml()).resolves.toBe("<html>renderer</html>");
  });
});
