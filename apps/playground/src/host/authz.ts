import type { AuthzPort, Principal, Scope, VerifyRequest, VerifyResult } from "@kohaku-ui/spec-core";
import { DEFAULT_CAPABILITY_TTL_SECONDS } from "@kohaku-ui/spec-core";

/**
 * A playground-only WebCrypto-backed AuthzPort (`@kohaku-ui/spec-core`'s contract, verified against
 * `@kohaku-ui/port-contracts`'s `describeAuthzPortContract` — see `test/authz.test.ts`). Not wire-compatible
 * with `@kohaku-ui/authz-hmac`'s own HMAC token format, deliberately: a token issued here never leaves the
 * browser tab that issued it (no server, no other process, no other language ever verifies it), so there is
 * no cross-process/cross-language compatibility to preserve. `authz-hmac` itself is unchanged — this exists
 * purely because that package's implementation calls `node:crypto`'s `createHmac`/`randomBytes`/
 * `timingSafeEqual`, none of which exist in a browser; `globalThis.crypto.subtle` is the Web Crypto
 * equivalent (also available in Node, so this same code runs identically under Vitest).
 */

interface PlaygroundClaims {
  sub: string;
  scopes: Scope[];
  /** Epoch seconds. */
  exp: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8ToBase64Url(text: string): string {
  return toBase64Url(new TextEncoder().encode(text));
}

function base64UrlToUtf8(value: string): string {
  return new TextDecoder().decode(fromBase64UrlToBytes(value));
}

/**
 * Constant-time string comparison, byte by byte (Web Crypto has no `timingSafeEqual` equivalent —
 * `node:crypto`'s own is what authz-hmac uses, and it is not available here). Compares the UTF-8 bytes of
 * the two base64url strings directly rather than decoding them first, mirroring authz-hmac's own
 * `Buffer.from(signature)` vs `Buffer.from(expected)` comparison (equal strings iff equal underlying bytes,
 * since base64url encoding is a deterministic bijection — decoding first would only do extra work for the
 * same answer). Always walks every byte instead of short-circuiting on the first mismatch, so how much of
 * the signature matched leaks nothing through timing.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i]! ^ bBytes[i]!;
  return diff === 0;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export interface PlaygroundAuthzOptions {
  /** Default capability lifetime (seconds) when issueCapability's own opts.ttlSeconds is omitted. Defaults to 600. */
  ttlSeconds?: number;
}

/**
 * A homegrown HMAC-SHA256 capability token, WebCrypto-backed: base64url(payload).base64url(hmac), payload =
 * { sub, scopes: [{kind, ref}], exp } (no `jti` — this playground has no revocation store, so there is
 * nothing to revoke by; every token simply expires on its own).
 */
export function createPlaygroundAuthzPort(secret: string, options: PlaygroundAuthzOptions = {}): AuthzPort {
  const defaultTtl = options.ttlSeconds ?? DEFAULT_CAPABILITY_TTL_SECONDS;
  // Imported once per port instance; `crypto.subtle.importKey` is itself async, so every sign() call awaits
  // the same promise rather than re-importing the key on every issue/verify.
  const keyPromise = importHmacKey(secret);

  async function sign(payload: string): Promise<string> {
    const key = await keyPromise;
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    return toBase64Url(new Uint8Array(signature));
  }

  return {
    async issueCapability(principal: Principal, scopes: Scope[], opts = {}): Promise<string> {
      const claims: PlaygroundClaims = {
        sub: principal.id,
        scopes,
        exp: nowSeconds() + (opts.ttlSeconds ?? defaultTtl),
      };
      const payload = utf8ToBase64Url(JSON.stringify(claims));
      return `${payload}.${await sign(payload)}`;
    },

    async verify(token: string, req: VerifyRequest): Promise<VerifyResult> {
      const dot = token.lastIndexOf(".");
      if (dot < 0) return { ok: false, reason: "malformed token" };
      const payload = token.slice(0, dot);
      const signature = token.slice(dot + 1);

      const expected = await sign(payload);
      if (!timingSafeEqualStr(signature, expected)) {
        return { ok: false, reason: "invalid signature" };
      }

      let claims: PlaygroundClaims;
      try {
        claims = JSON.parse(base64UrlToUtf8(payload)) as PlaygroundClaims;
      } catch {
        return { ok: false, reason: "malformed payload" };
      }

      if (claims.exp <= nowSeconds()) {
        return { ok: false, reason: "capability expired" };
      }
      const granted = claims.scopes.some((scope) => scope.kind === req.kind && scope.ref === req.ref);
      if (!granted) {
        return { ok: false, reason: `scope does not cover ${req.kind}:${req.ref}` };
      }
      return { ok: true, principal: { id: claims.sub } };
    },
  };
}
