import type { KohakuHostDeps } from "@kohaku-ui/host-rest";
import type { MiddlewareHandler } from "hono";

/**
 * REST-only request → principal/tenant resolution (Hono middleware + host-rest's `auth`/`tenant` hooks).
 * Kept apart from `../ports/from-env.ts` (which only selects the StoragePort/AuthzPort adapter and has no
 * business importing hono / host-rest) so that sample-mcp, which imports `from-env.ts`'s adapter-selection
 * exports via the package's `./ports/from-env` subpath, never pulls in the REST framework.
 *
 * The JWT scheme (`createJwtRequestIdentity`) lives in the sibling `request-identity-jwt.ts` instead of
 * here, so this file — which `app.ts` imports unconditionally for `createHeaderIdentity` — has no
 * `@kohaku-ui/authz-jwt` import: `app.ts` is also the `./browser` export's entry point, and JWT
 * verification (an env/secret-store-backed Node concern) has no business reaching a browser bundle.
 * index.ts imports `request-identity-jwt.ts` directly, only when it actually needs it.
 */

/** How the REST host turns a request into a principal and a tenant. */
export interface RequestIdentity {
  /** Registered on `/api/kohaku/*` ahead of the routes when present (JWT verification + 401). */
  middleware?: MiddlewareHandler;
  auth: NonNullable<KohakuHostDeps["auth"]>;
  tenant: NonNullable<KohakuHostDeps["tenant"]>;
}

/** The demo's header scheme (unchanged): x-kohaku-role (no header = admin) and x-kohaku-tenant. */
export function createHeaderIdentity(): RequestIdentity {
  return {
    // Principal resolution (product responsibility): in real operation, resolve the principal and roles from an auth
    // platform (JWT/OIDC, etc.). The demo substitutes the x-kohaku-role header and treats **no header (default) as admin**
    // (so as not to break the unauthorized behavior of the existing demo and tests; it reproduces, via the admin role,
    // the legacy behavior where the governance plane lets anyone through).
    auth: async (c) => {
      const role = c.req.header("x-kohaku-role") || "admin";
      return { id: `demo-${role}`, roles: [role] };
    },
    // Tenant resolution: the demo looks at the x-kohaku-tenant header. The governance plane (lineage / promotion /
    // fixation) is separated per tenant. query:// is tenant-neutral and does not mix tenant into the cache key (an invariant).
    // Full-fledged tenant isolation (RLS, etc.) is a product responsibility (specification.md §4.4 / §7).
    tenant: (c) => c.req.header("x-kohaku-tenant") || undefined,
  };
}
