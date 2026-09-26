import type { JwtIdentityResolver, ResolvedIdentity } from "@kohaku-ui/authz-jwt";
import { JwtIdentityError } from "@kohaku-ui/authz-jwt";
import { errorBody } from "@kohaku-ui/host-rest";
import type { Context } from "hono";
import type { RequestIdentity } from "./request-identity.js";

/**
 * The JWT `RequestIdentity` scheme, split out of `request-identity.ts` so `@kohaku-ui/authz-jwt` is never
 * reachable from `app.ts` (the shared, browser-reachable createApp entry — see request-identity.ts's own
 * doc comment). Only index.ts imports this file, and only when `KOHAKU_AUTHZ=jwt` actually selects it.
 */

const IDENTITY_VAR = "kohakuIdentity";

/**
 * JWT scheme: the middleware verifies the bearer token once per request and stores the identity on the
 * context; the hooks read it back. A missing or invalid token is a 401 with the standard error envelope
 * (CAPABILITY_DENIED — the SPEC §6.1 code set has no separate "unauthenticated" code, and the envelope is
 * what clients already parse). Principal / roles / tenant then all come from the token, never from headers.
 */
export function createJwtRequestIdentity(identity: JwtIdentityResolver): RequestIdentity {
  const read = (c: Context): ResolvedIdentity | undefined =>
    c.get(IDENTITY_VAR) as ResolvedIdentity | undefined;
  return {
    middleware: async (c, next) => {
      try {
        c.set(IDENTITY_VAR, await identity.fromAuthorizationHeader(c.req.header("authorization")));
      } catch (e) {
        const reason = e instanceof JwtIdentityError ? e.code : "INVALID_TOKEN";
        return c.json(errorBody("CAPABILITY_DENIED", `authentication required (${reason})`), 401);
      }
      await next();
    },
    auth: async (c) => read(c)?.principal ?? null,
    tenant: (c) => read(c)?.tenant,
  };
}
