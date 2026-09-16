import { sha256Hex } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  buildSrcdoc,
  DEFAULT_CSP,
  SANDBOX_ATTRIBUTE,
  SandboxIntegrityError,
  verifyArtifact,
} from "../src/index.js";

const NONCE = "a".repeat(32);
const RPC_TIMEOUT_MS = 10_000;

describe("srcdoc composition and integrity verification", () => {
  it("the CSP meta and runtime are injected in <head>, before an always-empty <body>", () => {
    const html = "<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>";
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    const cspAt = doc.indexOf("Content-Security-Policy");
    const runtimeAt = doc.indexOf("domApplierMain");
    const bodyAt = doc.indexOf("<body>");
    expect(cspAt).toBeGreaterThan(-1);
    expect(cspAt).toBeLessThan(runtimeAt);
    expect(runtimeAt).toBeLessThan(bodyAt);
    expect(doc).toContain("connect-src 'none'");
    // Verifies that nonce and rpcTimeoutMs reach the embedded runtime/worker config (nested one JSON.stringify
    // deep — the worker shim config is itself a JSON string value inside the applier config — so its quotes
    // are backslash-escaped in the outer JSON).
    expect(doc).toContain(NONCE);
    expect(doc).toContain("rpcTimeoutMs");
    expect(doc).toContain(String(RPC_TIMEOUT_MS));
  });

  it("the generated artifact's own body markup is never spliced into the srcdoc HTML (the document body is always empty)", () => {
    const html = "<!DOCTYPE html><html><body><div id=app>generated content</div></body></html>";
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    // The document's own <body> element (as opposed to the embedded Worker boot config, which necessarily
    // repeats the body markup as a JSON string for the Worker's own parser to consume) is always empty.
    expect(doc).toContain("<body></body>");
    // The body markup does reach the Worker's boot config as a JSON string value, though (parsed there, not here).
    expect(doc).toContain("generated content");
  });

  it("always emits a single well-formed document (DOCTYPE + html + head + empty body)", () => {
    const doc = buildSrcdoc("<div>fragment</div>", DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    expect(doc.startsWith("<!DOCTYPE html><html><head>")).toBe(true);
    expect(doc.endsWith("<body></body></html>")).toBe(true);
    expect(doc.match(/<!DOCTYPE/gi)).toHaveLength(1);
  });

  it("extracts <title> into the document's own <title>, and generated <style> content into the document's own <style>", () => {
    const html =
      "<!DOCTYPE html><html><head><title>Sales trend</title><style>body{color:red}</style></head><body></body></html>";
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    expect(doc).toContain("<title>Sales trend</title>");
    expect(doc).toContain("<style>body{color:red}</style>");
  });

  it("script-src is nonce-only (no 'unsafe-inline'), so a generated <script> in the srcdoc HTML never runs directly", () => {
    const html =
      "<!DOCTYPE html><html><body><script>/*generated-evil*/window.evil=1</script><!-- <head> --><body>hi</body>";
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    // The generated script's *content* only ever appears embedded as a JSON string value bound for the
    // Worker — never as a second, separately-executable <script> tag in the document itself.
    expect(doc.match(/<script/gi)).toHaveLength(1);
    expect(doc).toContain(`<script nonce="${NONCE}">`);
    expect(doc).toContain(`script-src 'nonce-${NONCE}'`);
    expect(doc).not.toContain("script-src 'unsafe-inline'");
  });

  it("themeCss is injected as a <style> before any generated CSS", () => {
    const html = "<!DOCTYPE html><html><head><title>x</title><style>.gen{color:blue}</style></head></html>";
    const themeCss = ":root{--kohaku-color-primary:#4f46e5;}";
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS, themeCss);
    const themeAt = doc.indexOf("<style>:root{--kohaku-color-primary:#4f46e5;}</style>");
    const genAt = doc.indexOf("<style>.gen{color:blue}</style>");
    expect(themeAt).toBeGreaterThan(-1);
    expect(genAt).toBeGreaterThan(-1);
    expect(themeAt).toBeLessThan(genAt);
  });

  it("with themeCss unspecified / empty, no theme <style> is injected (srcdoc identical to before)", () => {
    const html = "<!DOCTYPE html><html><body>hi</body></html>";
    expect(buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS)).toBe(
      buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS, ""),
    );
  });

  it("CSP blocks the network by default and authorizes only the trusted document's own nonce'd script and its blob Worker", () => {
    expect(DEFAULT_CSP).toContain("connect-src 'none'");
    expect(DEFAULT_CSP).toContain("default-src 'none'");
    expect(DEFAULT_CSP).toContain("frame-src 'none'");
    expect(DEFAULT_CSP).toContain("script-src 'none'");
    expect(DEFAULT_CSP).toContain("worker-src blob:");
    expect(DEFAULT_CSP).toContain("child-src blob:");
  });

  it("the sandbox attribute is allow-scripts only (does not include allow-same-origin)", () => {
    expect(SANDBOX_ATTRIBUTE).toBe("allow-scripts");
  });

  it("the resolved CSP never contains http:/https: sources", () => {
    expect(DEFAULT_CSP).not.toMatch(/https?:/i);
  });

  it("a generated script/body containing </script> cannot break out of the embedding <script> tag", () => {
    const html =
      '<!DOCTYPE html><html><body><div id="x"></div><script>var s = "</script><script>alert(1)</script>";</script></body></html>';
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    expect(doc.match(/<script/gi)).toHaveLength(1);
    expect(doc).not.toContain("</script><script>alert(1)");
  });

  it("a </style >-style breakout in generated CSS cannot close the trusted <style> and inject a meta refresh", () => {
    // splitArtifact's STYLE_RE requires an exact "</style>" (no whitespace before ">") to end its own
    // extraction, so "</STYLE >" (space before ">") isn't recognized there and ends up captured as part of
    // the CSS text — but a real HTML parser IS lenient about that whitespace (RAWTEXT end-tag matching), so
    // without escaping it would end the trusted document's own <style> element early.
    const html =
      "<!DOCTYPE html><html><head><style>a{color:red}</STYLE >" +
      '<meta http-equiv="refresh" content="0;url=https://evil.example">' +
      "b{color:blue}</style></head><body></body></html>";
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    expect(parsed.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(parsed.querySelectorAll("style")).toHaveLength(1);
  });

  it("a </STYLE\\n>-style breakout (newline before the closing angle bracket) is escaped the same way", () => {
    const html =
      "<!DOCTYPE html><html><head><style>a{color:red}</STYLE\n>" +
      '<meta http-equiv="refresh" content="0;url=https://evil.example">' +
      "b{color:blue}</style></head><body></body></html>";
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS);
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    expect(parsed.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(parsed.querySelectorAll("style")).toHaveLength(1);
  });

  it("a </style >-style breakout in themeCss is escaped the same way as generated CSS", () => {
    const html = "<!DOCTYPE html><html><head></head><body></body></html>";
    const themeCss =
      ":root{--kohaku-color-primary:#000}</STYLE >" +
      '<meta http-equiv="refresh" content="0;url=https://evil.example">';
    const doc = buildSrcdoc(html, DEFAULT_CSP, NONCE, RPC_TIMEOUT_MS, themeCss);
    const parsed = new DOMParser().parseFromString(doc, "text/html");
    expect(parsed.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  });

  it("verifyArtifact rejects a sha256 mismatch", async () => {
    const html = "<html><body>ok</body></html>";
    const sha256 = await sha256Hex(html);
    await expect(verifyArtifact({ inline: html, sha256 })).resolves.toBeUndefined();
    await expect(verifyArtifact({ inline: html + " ", sha256 })).rejects.toThrow(SandboxIntegrityError);
  });
});
