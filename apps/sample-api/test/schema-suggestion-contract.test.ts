import type { SchemaExtractionResult } from "@kohaku-ui/evals";
import type { SchemaSuggestion } from "@kohaku-ui/lineage";
import { describe, expectTypeOf, it } from "vitest";

/**
 * Drift guard for the duplicate definition of the extractor's proposal, the same idiom as
 * component-draft-contract.test.ts's ComponentDraft guard.
 *
 * Because of the dependency direction (no back-flow: evals and lineage are siblings, neither may depend on the
 * other), the proposal type is held separately in evals (SchemaExtractionResult, schema-extraction.ts) and
 * lineage (SchemaSuggestion, promotion/suggestion.ts). The assignment at app/promotions.ts's suggestSchema
 * wiring only checks one direction at the call site (the extractor's return value flows into a
 * `Promise<SchemaSuggestion | null>`-typed hook, so a *removal* or *narrowing* on the evals side, or a new
 * *required* field on the lineage side, already fails `pnpm typecheck` there) — but an *added* field on
 * SchemaExtractionResult is not caught by that one-directional flow (it is not an object literal at the
 * assignment, so excess-property checking never applies), and would otherwise ride silently onto the wire via
 * `data.suggestion`. Pinning mutual assignability here at the type level (checked by tsc = `pnpm typecheck`;
 * there is no runtime logic) makes an addition on either side a typecheck failure instead.
 */
describe("SchemaExtractionResult / SchemaSuggestion dual-definition drift guard (evals <-> lineage)", () => {
  it("evals' SchemaExtractionResult and lineage's SchemaSuggestion are mutually assignable", () => {
    // If either direction drifts (a field added, removed, narrowed or widened on one side but not the other),
    // the toExtend in that direction becomes a typecheck error.
    expectTypeOf<SchemaExtractionResult>().toExtend<SchemaSuggestion>();
    expectTypeOf<SchemaSuggestion>().toExtend<SchemaExtractionResult>();
  });
});
