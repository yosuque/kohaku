import type { ComposeContext } from "@kohaku-ui/composer";
import { createGovernancePolicy, type KohakuHostDeps } from "@kohaku-ui/host-rest";
import {
  createViewRecorder,
  type Fixations,
  type Lineage,
  type Promotions,
  summarizeLineage,
} from "@kohaku-ui/lineage";
import type { AuthzPort, DomainPort, StoragePort } from "@kohaku-ui/spec-core";
import { salesActionEffects } from "../action-effects.js";
import type { RequestIdentity } from "../ports/from-env.js";
import { admitFixationForLocale } from "./compose-context.js";

/**
 * Assembles the KohakuHostDeps for host-rest.
 * lineage / promotions / fixations / composeCtx / domain receive the caller's shared instances and are not
 * regenerated internally (only recorder is derived from lineage).
 */
export function createHostDeps(args: {
  composeCtx: ComposeContext;
  domain: DomainPort;
  authz: AuthzPort;
  storage: StoragePort;
  lineage: Lineage;
  promotions: Promotions;
  fixations: Fixations;
  identity: RequestIdentity;
}): KohakuHostDeps {
  const { composeCtx, domain, authz, storage, lineage, promotions, fixations, identity } = args;
  return {
    compose: composeCtx,
    domain,
    authz,
    querySource: "sales",
    // Principal / tenant resolution (product responsibility) is delegated to `identity` (from-env.ts):
    // either the demo's header scheme (createHeaderIdentity) or verified JWT claims (createJwtRequestIdentity).
    // See from-env.ts's doc comments for the rationale of each.
    auth: identity.auth,
    // Declarative RBAC for the governance plane (SPEC §6.1 governance-plane authorization [Draft]). A role -> allowed-operation
    // matrix: admin=all allowed / reviewer=promotion review + lineage viewing / viewer=read-only. Switching to viewer
    // makes approval/deletion operations (promotion.approve / fixation.remove, etc.) return 403 CAPABILITY_DENIED.
    // Unknown roles and out-of-permission are denied (deny-by-default). Role resolution is handled by auth above (product responsibility).
    authorizeGovernance: createGovernancePolicy({
      roles: {
        // admin=all allowed / reviewer=promotion review + Lineage viewing / viewer=read-only.
        // analytics.read (usage analytics) is a read operation, so admin/reviewer/viewer can all view it.
        admin: ["*"],
        reviewer: ["promotion.*", "lineage.read", "analytics.read"],
        viewer: [
          "lineage.read",
          "analytics.read",
          "promotion.list",
          "promotion.get",
          "fixation.list",
          "fixation.proposals",
        ],
      },
    }),
    // Tenant resolution (product responsibility) is likewise delegated to `identity`. The governance plane
    // (lineage / promotion / fixation) is separated per tenant. query:// is tenant-neutral and does not mix
    // tenant into the cache key (an invariant). Full-fledged tenant isolation (RLS, etc.) is a product
    // responsibility (specification.md §4.4 / §7).
    tenant: identity.tenant,
    recorder: createViewRecorder(lineage),
    // Observability hook for the failure path (the demo is console-based). When wired, a requestId is issued that
    // matches error.requestId in the error response, letting you correlate logs with the client's error.
    // Failures that are "swallowed while the response stays successful", such as a recorder (lineage recording) failure, also reach here.
    onError: ({ endpoint, requestId, error }) => {
      console.error(`[host-rest] A failure occurred in ${endpoint} (requestId=${requestId}):`, error);
    },
    // The fixation short-circuit looks up the given tenant's fixation by session.tenant. Delivery gating
    // (the demo's EN-only language policy) is separated out into fixationAdmit below (shared verbatim with
    // the MCP profile's wiring in sample-mcp's setup.ts), so this stays a plain read.
    fixationLookup: (hash, session) => storage.getFixation(hash, session.tenant),
    fixationAdmit: admitFixationForLocale,
    promotions,
    fixations,
    // Usage analytics. Injects lineage's pure aggregation summarizeLineage (host-rest stays lineage-independent).
    analyticsSummarizer: summarizeLineage,
    // Side-effect declaration of the write loop (annotate). The implementation is consolidated in action-effects.ts's
    // salesActionEffects and shared with the MCP side (sample-mcp's setup.ts) (not duplicated).
    actionEffects: salesActionEffects,
  };
}
