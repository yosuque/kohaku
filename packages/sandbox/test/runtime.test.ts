// Import from the node-independent subpath that preserves the dependency direction (via the barrel it would drag type
// resolution all the way to composer -> llm's node-dependency source, breaking the node-independent sandbox's typecheck. Defined in packages/composer/src/l2-api.ts).
import { KOHAKU_API_ALLOWLIST } from "@kohaku-ui/composer/l2-api";
import { describe, expect, it } from "vitest";
import { buildWorkerShimJs } from "../src/guest/worker-shim.js";
import { buildRuntimeJs } from "../src/runtime.js";

/**
 * Extracts, from buildWorkerShimJs's output, the set of method names that self.kohaku actually exposes (for
 * A1's drift check). It slices out the `g.kohaku = { ... }` object literal by brace matching and picks up
 * only the `name(` / `name:` directly under it (depth 1). Because keys inside nested function bodies or calls
 * are excluded by depth, it is robust to reformatting of the shim implementation (indentation changes, etc.).
 */
function extractKohakuApiNames(js: string): Set<string> {
  const marker = "g.kohaku = {";
  const at = js.indexOf(marker);
  if (at < 0) {
    throw new Error("g.kohaku definition not found in the worker shim (extractor needs updating)");
  }
  const open = at + marker.length - 1; // the position of the immediately following '{'
  const names = new Set<string>();
  let depth = 0;
  let token = "";
  for (let i = open; i < js.length; i++) {
    const ch = js[i]!;
    // A depth-1 method-shorthand key (`fetchData(ref) { ... }`) must be captured from `token` before the
    // "(" below is treated as a generic bracket-open (which would clear token first).
    if (ch === "(" && depth === 1 && token.length > 0) {
      names.add(token);
      token = "";
      depth++;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") {
      depth++;
      token = "";
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      depth--;
      token = "";
      if (ch === "}" && depth === 0) break; // the end of the kohaku literal
      continue;
    }
    if (depth !== 1) continue; // target only the top-level keys directly under the literal
    if (/[A-Za-z0-9_$]/.test(ch)) {
      token += ch;
    } else if (ch === ":" && token.length > 0) {
      names.add(token);
      token = "";
    } else {
      token = "";
    }
  }
  return names;
}

const CONFIG = { rpcTimeoutMs: 7500, viewportWidth: 800, bodyHtml: "" };

describe("buildWorkerShimJs (the Worker-side self.kohaku bridge)", () => {
  it("embeds rpcTimeoutMs and viewportWidth", () => {
    const js = buildWorkerShimJs(CONFIG);
    expect(js).toContain('"rpcTimeoutMs":7500');
    expect(js).toContain('"viewportWidth":800');
  });

  it("fetchData sets an rpcTimeoutMs timeout and, on timeout, removes the pending entry and rejects", () => {
    const js = buildWorkerShimJs(CONFIG);
    expect(js).toContain("config.rpcTimeoutMs");
    expect(js).toContain("delete pending[id]");
    expect(js).toContain("rpc timeout");
  });

  it("on receiving rpc-result, clears the pending timer", () => {
    const js = buildWorkerShimJs(CONFIG);
    expect(js).toContain("clearTimeout(p.timer)");
  });

  it("on receiving destroy, rejects all pending", () => {
    const js = buildWorkerShimJs(CONFIG);
    expect(js).toContain('rejectAllPending("sandbox destroyed")');
  });

  it("reports both synchronous errors (error) and async errors (unhandledrejection) to the document via telemetry", () => {
    // An exception inside an async function arrives at unhandledrejection rather than "error". If only one of the two
    // is caught, ready() is never sent and nothing renders until the boot timeout (the parent's immediate failure does not kick in).
    const js = buildWorkerShimJs(CONFIG);
    expect(js).toContain('addEventListener("error"');
    expect(js).toContain('addEventListener("unhandledrejection"');
    expect(js.match(/t: "telemetry"/g)!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildRuntimeJs (the trusted document's inline runtime)", () => {
  it("embeds the nonce and the DOM-shape limits, and stringifies domApplierMain", () => {
    const js = buildRuntimeJs({
      nonce: "n".repeat(32),
      rpcTimeoutMs: 7500,
      maxDomNodes: 20_000,
      maxDomDepth: 64,
      mutationsPerMinute: 6000,
      bodyHtml: "",
      scripts: "",
    });
    expect(js).toContain("n".repeat(32));
    expect(js).toContain('"maxDomNodes":20000');
    expect(js).toContain('"maxDomDepth":64');
    expect(js).toContain('"mutationsPerMinute":6000');
    expect(js).toContain("domApplierMain");
  });

  it("escapes '<' in the embedded JSON so a generated script/body cannot break out via </script> or <!--", () => {
    const js = buildRuntimeJs({
      nonce: "n".repeat(32),
      rpcTimeoutMs: 5000,
      maxDomNodes: 20_000,
      maxDomDepth: 64,
      mutationsPerMinute: 6000,
      bodyHtml: "",
      scripts: 'document.title = "</script><script>alert(1)</script>";',
    });
    expect(js).not.toContain("</script><script>alert(1)");
    expect(js).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
  });
});

// A1: the composer's L2 hallucinated-API detection (collectL2Issues's KOHAKU_API_ALLOWLIST) and the self.kohaku
// surface that the Worker shim actually exposes were duplicated definitions with no drift check until now.
// Since sandbox is downstream of composer, having composer as a devDependency is correct with respect to
// dependency direction (the same as the precedent of renderer-wc holding renderer-react as a devDep). We
// extract the exposed API from the shim's output and reconcile them.
describe("A1: drift check between the L2 allowed API set and the worker shim's exposed surface", () => {
  it("composer's KOHAKU_API_ALLOWLIST matches the self.kohaku surface the worker shim exposes", () => {
    const js = buildWorkerShimJs(CONFIG);
    const shimApis = extractKohakuApiNames(js);
    // So that a broken extractor does not misjudge two empty sets as "matching", first confirm there is a minimum surface.
    expect(shimApis.size).toBeGreaterThanOrEqual(4);
    expect([...shimApis].sort()).toEqual([...KOHAKU_API_ALLOWLIST].sort());
  });
});
