import {
  DEFAULT_MAX_DOM_DEPTH,
  DEFAULT_MAX_DOM_NODES,
  DEFAULT_MUTATIONS_PER_MINUTE,
} from "@kohaku-ui/spec-core";
import type { ResolvedSandboxPolicy, SandboxPolicy } from "./types.js";

/**
 * Default CSP: physically blocks network I/O (connect-src 'none'). `script-src 'none'` is the resting value —
 * `applyRuntimeNonce` swaps it for `script-src 'nonce-<per-mount nonce>'` once resolvePolicy has produced the
 * final string, so only the trusted document's own bootstrap `<script nonce>` (domApplierMain) can ever run;
 * the old `'unsafe-inline'` value (removed here) is no longer needed now that generated code executes inside a
 * Worker rather than as an inline `<script>` in the document itself (see docs/design.md §8). `worker-src
 * blob:` / `child-src blob:` (the latter for older engines that consult it instead of worker-src) authorize
 * the one blob Worker the applier boots; `frame-src 'none'` still wins over `child-src` for iframes, so this
 * does not reopen the frame-src closure.
 * The second layer of the triple defense (layer 1 = the iframe sandbox attribute, layer 3 = the bridge allowlist).
 */
export const DEFAULT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src blob:",
  "child-src blob:",
].join("; ");

/** iframe sandbox attribute. Does not include allow-same-origin (forces an opaque origin). */
export const SANDBOX_ATTRIBUTE = "allow-scripts";

/** Shared encoder for size-limit checks (avoids recreating it on every call). */
const utf8Encoder = new TextEncoder();

/**
 * The UTF-8 byte length of a string. Size limits are judged by actual bytes rather than .length (UTF-16 code units) —
 * because for multibyte characters .length is 1/3 to 1/4 of the actual bytes and would slip past the limit.
 */
export function utf8ByteLength(s: string): number {
  return utf8Encoder.encode(s).length;
}

/**
 * CSP directives that reject relaxation (so the second layer of the triple defense cannot be erased by a single setting).
 * These are pinned to the DEFAULT_CSP value ('none'); if custom specifies a different value, it is rejected Fail-Fast.
 */
const PINNED_CSP_DIRECTIVES = [
  "default-src",
  "connect-src",
  "form-action",
  "base-uri",
  "object-src",
  "frame-src",
] as const;

/**
 * Fetch directives that can name an external origin. A relaxation here (e.g. `img-src https:`) would open a
 * data-exfiltration path (loading an attacker-controlled URL leaks whatever is embedded in it), so unlike the
 * other non-pinned directives, these are validated rather than passed through verbatim: every source token must
 * be a member of CLOSED_SOURCE_TOKENS or match CLOSED_SOURCE_PATTERN (restrict-only / fail-closed).
 */
const FETCH_CSP_DIRECTIVES = new Set([
  "img-src",
  "font-src",
  "media-src",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "manifest-src",
  "prefetch-src",
]);

/**
 * Directives entirely owned by the sandbox runtime — a caller cannot set them at all, not even to restate the
 * default (a custom value present at all is rejected). `script-src` / `script-src-elem` / `script-src-attr`
 * differ per mount (`applyRuntimeNonce` substitutes the per-mount nonce after resolveCsp runs), so there is no
 * static default a caller could correctly restate; `worker-src` / `child-src` gate the exact `blob:` scheme
 * the trusted document uses to boot its own Worker, which only the runtime — not the product embedding it —
 * may decide.
 */
const RUNTIME_MANAGED_CSP_DIRECTIVES = new Set([
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "worker-src",
  "child-src",
]);

/**
 * Directives with no network implication are passed through unvalidated (e.g. `sandbox` mirrors the iframe
 * sandbox attribute inside the CSP; none of these can open an exfiltration path).
 */
const PASSTHROUGH_CSP_DIRECTIVES = new Set([
  "sandbox",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
  "require-trusted-types-for",
  "trusted-types",
]);

/** Source tokens that stay inside the closed area (never resolve to an external origin). */
const CLOSED_SOURCE_TOKENS = new Set([
  "'none'",
  "data:",
  "blob:",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'unsafe-hashes'",
]);

/** nonce-/sha256- family keyword sources also stay closed (they select inline content, not an external origin). */
const CLOSED_SOURCE_PATTERN = /^'(nonce|sha256|sha384|sha512)-[A-Za-z0-9+/=_-]+'$/;

function parseCspDirectives(csp: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of csp.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const [name, ...rest] = trimmed.split(/\s+/);
    if (name == null || name === "") continue;
    map.set(name.toLowerCase(), rest.join(" "));
  }
  return map;
}

/**
 * Validates and composes the custom CSP. Blocking directives (PINNED_CSP_DIRECTIVES) **must not be relaxed**:
 * if custom specifies a value different from the default it throws, and when omitted the default value is filled in.
 * Fetch directives (FETCH_CSP_DIRECTIVES) are restrict-only / fail-closed: every source token must stay inside
 * the closed area (CLOSED_SOURCE_TOKENS / CLOSED_SOURCE_PATTERN), so a product cannot open e.g. `img-src https:`
 * and turn an image URL into an exfiltration channel. Passthrough directives (PASSTHROUGH_CSP_DIRECTIVES) have no
 * network implication and are kept as-is. Anything else (report-uri / report-to / navigate-to / unknown
 * directives) is rejected outright — report-uri/report-to would exfiltrate CSP violation reports to an external
 * endpoint, and navigate-to no longer exists as a real directive.
 * Because allowing full replacement would let a single `connect-src *` erase the L2 closed area (the second layer of the triple defense).
 */
export function resolveCsp(custom?: string): string {
  if (custom == null) return DEFAULT_CSP;
  const defaults = parseCspDirectives(DEFAULT_CSP);
  const merged = parseCspDirectives(custom);
  for (const name of RUNTIME_MANAGED_CSP_DIRECTIVES) {
    if (merged.has(name)) {
      throw new Error(
        `SandboxPolicy.csp cannot set the "${name}" directive — it is managed by the sandbox runtime`,
      );
    }
    merged.set(name, defaults.get(name) ?? "'none'");
  }
  for (const name of PINNED_CSP_DIRECTIVES) {
    const pinned = defaults.get(name) ?? "'none'";
    const given = merged.get(name);
    if (given != null && given !== pinned) {
      throw new Error(
        `SandboxPolicy.csp cannot relax the "${name}" directive (it is pinned to the default "${name} ${pinned}"; network blocking is one of the sandbox's defense layers)`,
      );
    }
    merged.set(name, pinned);
  }
  for (const [name, value] of merged) {
    if (RUNTIME_MANAGED_CSP_DIRECTIVES.has(name)) continue;
    if ((PINNED_CSP_DIRECTIVES as readonly string[]).includes(name)) continue;
    if (FETCH_CSP_DIRECTIVES.has(name)) {
      const tokens = value.split(/\s+/).filter((t) => t !== "");
      const bad = tokens.filter((t) => {
        const lower = t.toLowerCase();
        return !CLOSED_SOURCE_TOKENS.has(lower) && !CLOSED_SOURCE_PATTERN.test(lower);
      });
      if (bad.length > 0) {
        // 'self' falls into `bad` too: under the sandbox iframe's opaque origin it matches nothing, so it is
        // rejected the same as any other external-origin token rather than special-cased as harmless.
        throw new Error(
          `SandboxPolicy.csp cannot open the "${name}" directive to external origins (rejected: ${bad.join(" ")}; ` +
            "only 'none' / data: / blob: / inline keyword sources are accepted — network blocking is one of the sandbox's defense layers)",
        );
      }
      continue;
    }
    if (PASSTHROUGH_CSP_DIRECTIVES.has(name)) continue;
    throw new Error(`SandboxPolicy.csp directive "${name}" is not supported inside the sandbox`);
  }
  return [...merged.entries()].map(([n, v]) => (v === "" ? n : `${n} ${v}`)).join("; ");
}

/**
 * Substitutes the per-mount nonce into the resolved CSP's `script-src 'none'` (RUNTIME_MANAGED_CSP_DIRECTIVES
 * guarantees resolveCsp never lets a caller supply their own script-src, so this replacement always has
 * exactly one match). This is what actually authorizes the trusted document's own bootstrap `<script nonce>`
 * — every other script (including the whole generated L2 artifact) runs inside the Worker instead, which has
 * no script-src of its own to satisfy in the first place. Called once per mount by buildSrcdoc, using the same
 * nonce as the handshake (generateNonce()).
 */
export function applyRuntimeNonce(csp: string, nonce: string): string {
  return csp.replace("script-src 'none'", `script-src 'nonce-${nonce}'`);
}

export function resolvePolicy(policy: SandboxPolicy = {}): ResolvedSandboxPolicy {
  return {
    csp: resolveCsp(policy.csp),
    bootTimeoutMs: policy.bootTimeoutMs ?? 5000,
    rpcTimeoutMs: policy.rpcTimeoutMs ?? 10000,
    fetchesPerMinute: policy.fetchesPerMinute ?? 30,
    maxConcurrentFetches: policy.maxConcurrentFetches ?? 2,
    maxPayloadBytes: policy.maxPayloadBytes ?? 1024 * 1024,
    maxHtmlBytes: policy.maxHtmlBytes ?? 256 * 1024,
    maxHeightPx: policy.maxHeightPx ?? 4096,
    eventsPerMinute: policy.eventsPerMinute ?? 60,
    telemetryPerMinute: policy.telemetryPerMinute ?? 60,
    resizesPerMinute: policy.resizesPerMinute ?? 120,
    maxEventPayloadBytes: policy.maxEventPayloadBytes ?? 16 * 1024,
    // NOTE: resolved here for completeness and forward compatibility, but buildSrcdoc's frozen signature (see
    // its docstring) has no parameter to carry a per-mount override through to the Worker/applier — it always
    // builds with the spec-core DEFAULT_MAX_DOM_* / DEFAULT_MUTATIONS_PER_MINUTE constants regardless of what
    // is resolved here. A caller-supplied override is accepted (no validation error) but currently has no
    // effect; see docs/design.md §8 for the same caveat surfaced to users.
    maxDomNodes: policy.maxDomNodes ?? DEFAULT_MAX_DOM_NODES,
    maxDomDepth: policy.maxDomDepth ?? DEFAULT_MAX_DOM_DEPTH,
    mutationsPerMinute: policy.mutationsPerMinute ?? DEFAULT_MUTATIONS_PER_MINUTE,
  };
}

/** Fixed-window rate limiter (for the bridge's fetch quota) */
export class FixedWindowLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  tryAcquire(): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  /**
   * The start time of the current window. Called right after tryAcquire() returns false, it uniquely identifies the
   * window in which the overrun occurred (used on the host side to implement "notify only on the first time per window").
   */
  windowAt(): number {
    return this.windowStart;
  }
}
