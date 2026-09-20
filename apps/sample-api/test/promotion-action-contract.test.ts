import type { PromotionAction } from "@kohaku-ui/lineage";
import type { Principal } from "@kohaku-ui/spec-core";
import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { PromotionAction as ClientPromotionAction } from "../../../packages/client/src/types.js";
import type { PromotionActionSchema } from "../../../packages/host-rest/src/routes/schemas.js";

/**
 * Drift guard (H17) for the promotion action union, declared three times with no shared source of truth:
 * - lineage's `PromotionAction` (packages/lineage/src/promotion/machine.ts) — the domain type `transition()`
 *   and `Promotions.act()` operate on.
 * - host-rest's `PromotionActionSchema` (packages/host-rest/src/routes/schemas.ts) — the wire Zod schema
 *   validating the body of POST /promotions/:artifactId/actions.
 * - client's `PromotionAction` (packages/client/src/types.ts) — the typed host client SDK's view of the
 *   same action, sent as that request's body.
 * If the three drift structurally, the generic action route (packages/host-rest/src/routes/promotions.ts)
 * breaks at runtime even though each side typechecks on its own.
 *
 * Neither `PromotionActionSchema` nor the client's `PromotionAction` is part of its package's public export
 * surface (unlike `ComponentDraftSchema` / `ComponentDraftInput`, which the sibling
 * component-draft-contract.test.ts guards the same way through `@kohaku-ui/host-rest`'s barrel export, and
 * which `@kohaku-ui/client` is not currently a dependency of sample-api at all). This test is scoped to add no
 * production code, so both are reached with a relative import straight into their source files instead of
 * `@kohaku-ui/host-rest` / `@kohaku-ui/client` — the only way to pin the *actual* declared types here without
 * hand-copying them (a hand-copied mirror would guard nothing: it could drift from the real declarations the
 * same way the three originals already can). Flagged as a concern in the task-3 report; a tidier follow-up
 * would export a `PromotionActionInput` type from host-rest (mirroring `ComponentDraftInput`) and add
 * `@kohaku-ui/client` as a sample-api devDependency, so this reaches both through the ordinary package API.
 *
 * host-rest's `withPrincipal` (routes/promotions.ts) is the actual point where the wire shape becomes the
 * domain shape: it injects the server-side principal onto `by` for `nominate` and onto `reviewer` for
 * `review.approve` / `review.requestChanges` / `review.reject` — the request body itself never carries those
 * fields (host-rest's own PromotionActionSchema comment: "reviewer / by (Principal) do not accept a client
 * declaration"). `WithServerPrincipal` mirrors that exactly, so assertion (b) below compares against what the
 * route actually sends into `Promotions.act()`, not the raw wire schema.
 */

type SchemaAction = z.infer<typeof PromotionActionSchema>;

/** Mirrors host-rest's routes/promotions.ts `withPrincipal`. */
type WithServerPrincipal<A extends { kind: string }> = A extends { kind: "nominate" }
  ? A & { by: Principal }
  : A extends { kind: "review.approve" | "review.requestChanges" | "review.reject" }
    ? A & { reviewer: Principal }
    : A;

describe("promotion action union drift guard (lineage <-> host-rest <-> client)", () => {
  it("lineage's PromotionAction and host-rest's PromotionActionSchema have the same set of `kind` literals", () => {
    // If either side adds/renames/removes a kind without the other, this toEqualTypeOf becomes a typecheck error.
    expectTypeOf<PromotionAction["kind"]>().toEqualTypeOf<SchemaAction["kind"]>();
  });

  it("the schema's action, with the principal withPrincipal() injects, is assignable to lineage's PromotionAction", () => {
    // If a field host-rest's route relies on (including by/reviewer) drifts from what lineage's machine
    // expects, this toExtend becomes a typecheck error.
    expectTypeOf<WithServerPrincipal<SchemaAction>>().toExtend<PromotionAction>();
  });

  it("the client's PromotionAction is assignable to host-rest's PromotionActionSchema input type", () => {
    // If the client's request-body type stops matching what the server actually accepts, this toExtend
    // becomes a typecheck error.
    expectTypeOf<ClientPromotionAction>().toExtend<SchemaAction>();
  });
});
