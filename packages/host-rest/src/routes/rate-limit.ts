import type { Context, Next } from "hono";
import { errorBody } from "../errors.js";
import type { RouteContext } from "./shared.js";
import { resolveTenant } from "./shared.js";

/**
 * Builds a Hono middleware checking `deps.rateLimiter` (host-core's `PolicyRateLimiter`, typically
 * `PolicyRuntime.rateLimiter` -- see that type's own doc for how it resolves the effective
 * `RateLimitRule` per tenant/routeClass from a Policy file) before letting a request reach its route
 * handler. A no-op (always calls `next()`) when `deps.rateLimiter` is unset (backward compatible).
 *
 * On denial, responds 429 with the error envelope's `code: RATE_LIMITED` (SPEC §6.1, REST-RL-001) and,
 * when the limiter reports a `retryAfterMs`, an HTTP `Retry-After` header in whole seconds (rounded up)
 * alongside the envelope's own `retryAfterMs` (milliseconds) -- the same dual representation
 * `errorBody`'s 4th parameter already supports.
 *
 * Mounted only on the specific compose-family paths (`createKohakuRoutes`), never on `"*"`: governance/
 * control-plane routes (`/lineage`, `/telemetry`, `/promotions*`, `/fixations*`) are excluded by
 * construction, not by an allow/deny list inside this function.
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

    if (result.retryAfterMs != null) {
      c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    }
    return c.json(errorBody("RATE_LIMITED", "rate limit exceeded", undefined, result.retryAfterMs), 429);
  };
}
