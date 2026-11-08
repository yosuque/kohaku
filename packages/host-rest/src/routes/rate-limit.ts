import { notifyHook } from "@kohaku-ui/host-core";
import type { Context, Next } from "hono";
import { errorBody } from "../errors.js";
import type { RouteContext } from "./shared.js";
import { requestIdOf, resolveTenant } from "./shared.js";

/** The rate-limit buckets: one per route family (`deps.rateLimiter`'s `routeClass`). */
export type RateLimitRouteClass = "compose" | "action" | "resolve";

/**
 * Takes one token from `deps.rateLimiter` for `(tenant, principal, routeClass)`. Returns `undefined` when the
 * request may proceed (also when no limiter is wired), or the ready-made 429 response on denial: the error
 * envelope's `code: RATE_LIMITED` (SPEC §6.1, REST-RL-001) carrying the request's `requestId`, and -- when the
 * limiter reports a `retryAfterMs` -- an HTTP `Retry-After` header in whole seconds (rounded up) alongside the
 * envelope's own `retryAfterMs` (milliseconds), the same dual representation `errorBody`'s 4th parameter
 * already supports. `deps.onRateLimited` (fire-and-forget) is notified of every denial.
 *
 * Shared by the middleware below (compose-family routes, keyed by the request's own identity) and by the
 * `/binding/*` handlers, which call it themselves *after* verifying the capability so the key is the
 * capability's signed tenant and subject rather than whatever the request headers claim (SPEC CAP-TEN-001).
 */
export async function takeRateLimit(
  ctx: RouteContext,
  c: Context,
  key: { tenant: string | undefined; principal: string; routeClass: RateLimitRouteClass },
): Promise<Response | undefined> {
  const { rateLimiter } = ctx.deps;
  if (rateLimiter == null) return undefined;
  const result = await rateLimiter.take(key);
  if (result.allow) return undefined;

  const requestId = requestIdOf(c, ctx.deps);
  void notifyHook(ctx.deps.onRateLimited, { ...key, requestId });
  if (result.retryAfterMs != null) {
    c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
  }
  return c.json(errorBody("RATE_LIMITED", "rate limit exceeded", requestId, result.retryAfterMs), 429);
}

/**
 * Builds a Hono middleware checking `deps.rateLimiter` (host-core's `PolicyRateLimiter`, typically
 * `PolicyRuntime.rateLimiter` -- see that type's own doc for how it resolves the effective
 * `RateLimitRule` per tenant/routeClass from a Policy file) before letting a request reach its route
 * handler. A no-op (always calls `next()`) when `deps.rateLimiter` is unset (backward compatible). The
 * limiting itself (and the 429 / `Retry-After` shape) is `takeRateLimit`.
 *
 * Mounted only on the specific compose-family paths (`createKohakuRoutes`: `/intent/normalize`,
 * `/compose`, `/compose/stream`, `/events`), never on `"*"`: governance/control-plane routes (`/lineage`,
 * `/telemetry`, `/promotions*`, `/fixations*`) are excluded by construction, not by an allow/deny list inside
 * this function. `/binding/resolve` and `/binding/action` are deliberately not mounted here: their identity
 * is the verified capability, so the handlers call `takeRateLimit` after verification instead.
 */
export function createRateLimitMiddleware(
  ctx: RouteContext,
  routeClass: RateLimitRouteClass,
): (c: Context, next: Next) => Promise<Response | undefined> {
  return async (c, next) => {
    if (ctx.deps.rateLimiter == null) {
      await next();
      return undefined;
    }

    const principal = await ctx.getPrincipal(c);
    const tenant = await resolveTenant(c, ctx.deps);
    const denied = await takeRateLimit(ctx, c, { tenant, principal: principal.id, routeClass });
    if (denied != null) return denied;
    await next();
    return undefined;
  };
}
