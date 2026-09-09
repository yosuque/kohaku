import type { ComponentDraftInput } from "@kohaku-ui/host-rest";
import type { ComponentDraft } from "@kohaku-ui/lineage";
import { describe, expectTypeOf, it } from "vitest";

/**
 * Drift guard for the duplicate definition of ComponentDraft.
 *
 * Because of the dependency direction (no back-flow: the relationship is host-rest <- lineage, not lineage -> host-rest), the promotion
 * ComponentDraft type is held separately in host-rest (z.infer of the zod schema ComponentDraftSchema = ComponentDraftInput) and
 * lineage (ComponentDraft in promotion/machine.ts). If the two drift structurally, the wiring of
 * approve / schema.propose breaks at runtime. Since sample-api can depend on both packages, here we
 * pin their mutual assignability at the type level (checked by tsc = `pnpm typecheck`; there is no runtime logic).
 */
describe("ComponentDraft dual-definition drift guard (host-rest <-> lineage)", () => {
  it("host-rest's ComponentDraftInput and lineage's ComponentDraft are mutually assignable", () => {
    // If either direction drifts, the toExtend in that direction becomes a typecheck error.
    expectTypeOf<ComponentDraftInput>().toExtend<ComponentDraft>();
    expectTypeOf<ComponentDraft>().toExtend<ComponentDraftInput>();
  });
});
