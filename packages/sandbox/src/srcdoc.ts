import {
  DEFAULT_MAX_DOM_DEPTH,
  DEFAULT_MAX_DOM_NODES,
  DEFAULT_MUTATIONS_PER_MINUTE,
  sha256Hex,
} from "@kohaku-ui/spec-core";
import { splitArtifact } from "./guest/artifact-parts.js";
import { applyRuntimeNonce } from "./policy.js";
import { buildRuntimeJs } from "./runtime.js";
import type { SandboxArtifact } from "./types.js";

export class SandboxIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxIntegrityError";
  }
}

/** Verifies the artifact's sha256 (guarding against tampering and mix-ups). Must be called before mount. */
export async function verifyArtifact(artifact: SandboxArtifact): Promise<void> {
  const actual = await sha256Hex(artifact.inline);
  if (actual !== artifact.sha256) {
    throw new SandboxIntegrityError(
      `artifact hash mismatch: expected ${artifact.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
    );
  }
}

/**
 * Composes the srcdoc document (a pure function). Unlike the pre-Worker implementation, the generated
 * artifact's own markup is never spliced into the srcdoc HTML at all — the document body is always empty.
 * `splitArtifact` pulls the artifact apart into title / styles / scripts / body, and only `buildRuntimeJs`'s
 * Worker (through its own sanitizing HTML parser, applier-enforced allowlist and all) ever turns the body
 * markup into DOM; the `<style>` content is trusted CSS text injected directly (styles carry no script
 * capability), but generated `<script>` bodies run only inside that Worker, never as an inline `<script>` in
 * this document (which the CSP's nonce-only `script-src` would refuse to run anyway — fail-closed if the
 * split itself is ever wrong).
 *
 * The srcdoc also inherits the parent's CSP, but because the meta CSP is applied as an intersection, the
 * stricter side always wins.
 *
 * themeCss (the `:root { --kohaku-*: … }` produced by renderer-core's sandboxThemeCss) is injected as a
 * `<style>` before the generated CSS, so the generated HTML's token references `var(--kohaku-*)` resolve here
 * — the artifact (the sha256 target) holds no values and stays theme-independent.
 *
 * Both `themeCss` and the generated CSS are run through `escapeStyleClose` before being placed inside the
 * trusted `<style>` element: neither is guaranteed free of a literal `</style>` (or `</STYLE\n>`, `</style >`,
 * etc. — the closing sequence a browser's HTML parser recognizes regardless of case or trailing whitespace
 * before `>`), which would otherwise close the trusted element early and let the remaining text be parsed as
 * document markup. `themeCss` is already sanitized by sandboxThemeCss, but this is defense in depth against a
 * caller that bypasses it.
 *
 * NOTE (documented judgment call): SandboxPolicy.maxDomNodes/maxDomDepth/mutationsPerMinute are resolved by
 * resolvePolicy but cannot reach this function without changing its frozen signature (kept exactly as before
 * so mountSandboxNode / renderer-react / renderer-wc / sample-web need no changes) — buildRuntimeJs is always
 * called with the spec-core defaults, matching resolvePolicy's own note.
 */
export function buildSrcdoc(
  html: string,
  csp: string,
  nonce: string,
  rpcTimeoutMs: number,
  themeCss?: string,
): string {
  const parts = splitArtifact(html);
  const nonceCsp = applyRuntimeNonce(csp, nonce);
  const runtimeJs = buildRuntimeJs({
    nonce,
    rpcTimeoutMs,
    maxDomNodes: DEFAULT_MAX_DOM_NODES,
    maxDomDepth: DEFAULT_MAX_DOM_DEPTH,
    mutationsPerMinute: DEFAULT_MUTATIONS_PER_MINUTE,
    bodyHtml: parts.body,
    scripts: parts.scripts.join("\n;\n"),
  });
  const titleTag = parts.title !== "" ? `<title>${escapeHtml(parts.title)}</title>` : "";
  const themeStyle =
    themeCss != null && themeCss !== "" ? `<style>${escapeStyleClose(themeCss)}</style>` : "";
  const generatedStyle =
    parts.styles.length > 0 ? `<style>${escapeStyleClose(parts.styles.join("\n"))}</style>` : "";
  const head =
    `<head><meta http-equiv="Content-Security-Policy" content="${escapeAttr(nonceCsp)}">` +
    `${titleTag}${themeStyle}${generatedStyle}` +
    `<script nonce="${nonce}">${runtimeJs}</script></head>`;
  return `<!DOCTYPE html><html>${head}<body></body></html>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('"', "&quot;");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Escapes `</` to `<\/` in CSS text bound for a trusted `<style>` element. `\/` is a valid CSS escape for `/`
 * (an escaped code point resolves to the character it names), so this changes nothing about how the CSS is
 * interpreted, but it means the text can no longer contain the literal three-character sequence `</` that an
 * HTML parser needs to recognize a closing tag — see buildSrcdoc's docstring for why this matters.
 */
function escapeStyleClose(value: string): string {
  return value.replaceAll("</", "<\\/");
}

/** 128-bit nonce (aids source verification of the handshake) */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
