import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthzPort, Principal, Scope } from "@kohaku-ui/spec-core";

/**
 * A homegrown HMAC-SHA256 capability token (on-behalf-of: the host acts under the user's delegated authority).
 * A structure whose contents are transparent, prioritizing didactic value: base64url(payload).base64url(hmac)
 * payload = { sub, scopes: [{kind, ref}], exp }
 */
export function createHmacAuthzPort(secret: string): AuthzPort {
  const sign = (payload: string): string => createHmac("sha256", secret).update(payload).digest("base64url");

  return {
    async issueCapability(principal: Principal, scopes: Scope[], opts = {}) {
      const payload = Buffer.from(
        JSON.stringify({
          sub: principal.id,
          scopes,
          exp: Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 600),
        }),
      ).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },

    async verify(token, req) {
      const dot = token.lastIndexOf(".");
      if (dot < 0) return { ok: false, reason: "malformed token" };
      const payload = token.slice(0, dot);
      const signature = token.slice(dot + 1);

      const expected = sign(payload);
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { ok: false, reason: "invalid signature" };
      }

      let claims: { sub: string; scopes: Scope[]; exp: number };
      try {
        claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return { ok: false, reason: "malformed payload" };
      }
      if (claims.exp < Math.floor(Date.now() / 1000)) {
        return { ok: false, reason: "capability expired" };
      }
      const granted = claims.scopes.some((scope) => scope.kind === req.kind && req.ref === scope.ref);
      if (!granted) {
        return { ok: false, reason: `scope does not cover ${req.kind}:${req.ref}` };
      }
      return { ok: true, principal: { id: claims.sub } };
    },
  };
}
