import { notifyHook } from "@kohaku-ui/host-core";
import type { Context, Next } from "hono";
import { errorBody } from "../errors.js";
import type { RouteContext } from "./shared.js";
import { requestIdOf, resolveTenant } from "./shared.js";

/**
 * Builds a Hono middleware checking `deps.rateLimiter` (host-core's `PolicyRateLimiter`, typically
 * `PolicyRuntime.rateLimiter` -- see that type's own doc for how it resolves the effective
 * `RateLimitRule` per tenant/routeClass from a Policy file) before letting a request reach its route
 * handler. A no-op (always calls `next()`) when `deps.rateLimiter` is unset (backward compatible).
 *
 * On denial, responds 429 with the error envelope's `code: RATE_LIMITED` (SPEC §6.1, REST-RL-001) --
 * carrying the request's `requestId`, like every other error envelope -- and, when the limiter reports a
 * `retryAfterMs`, an HTTP `Retry-After` header in whole seconds (rounded up) alongside the envelope's own
 * `retryAfterMs` (milliseconds) -- the same dual representation `errorBody`'s 4th parameter already
 * supports. `deps.onRateLimited` (fire-and-forget) is notified of every denial.
 *
 * Mounted only on the specific compose-family paths (`createKohakuRoutes`: `/intent/normalize`,
 * `/compose`, `/compose/stream`, `/events`, `/binding/action`, `/binding/resolve`), never on `"*"`:
 * governance/control-plane routes (`/lineage`, `/telemetry`, `/promotions*`, `/fixations*`) are excluded
 * by construction, not by an allow/deny list inside this function.
 */
export function createRateLimitMiddleware(
  ctx: RouteContext,
  routeClass: "compose" | "action" | "resolve",
): (c: Context, next: Next) => Promise<Response | undefined> {
  return async (c, next) => {
    const { rateLimiter } = ctx.deps;
    if (rateLimiter == null) {
      await next();
      return undefined;
    }

    const principal = await ctx.getPrincipal(c);
    const tenant = await resolveTenant(c, ctx.deps);
    const result = await rateLimiter.take({ tenant, principal: principal.id, routeClass });
    if (result.allow) {
      await next();
      return undefined;
    }

    const requestId = requestIdOf(c, ctx.deps);
    void notifyHook(ctx.deps.onRateLimited, { tenant, principal: principal.id, routeClass, requestId });
    if (result.retryAfterMs != null) {
      c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    }
    return c.json(errorBody("RATE_LIMITED", "rate limit exceeded", requestId, result.retryAfterMs), 429);
  };
}
