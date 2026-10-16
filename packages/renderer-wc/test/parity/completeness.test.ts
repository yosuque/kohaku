// Completeness of the parity corpus: every part type in the core catalog must be exercised by at least one
// parity test, so adding a core component (docs/runbooks, the add-component skill) without extending the
// corpus fails here instead of silently shipping a part whose React ⇄ WC equivalence nobody checks.

import { coreCatalog } from "@kohaku-ui/registry";
import type { UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { CHART_CORPUS, STRUCTURAL_CORPUS } from "./corpus.js";

/**
 * Part types covered by overlay.test.ts rather than by the shared corpora. An overlay is open or closed
 * through state + `visibleWhen`, so it is exercised with purpose-built Specs there (structure while open,
 * close governance, self-contained `state.set`) instead of as a static corpus entry. Kept explicit: a new
 * type does not become exempt by accident, it has to be added to this list on purpose. (This package has no
 * Node typings, so the list cannot be cross-checked against overlay.test.ts's source; keep them in step by
 * hand.)
 */
const OVERLAY_TYPES = ["overlay.dialog", "overlay.toast"] as const;

function typesIn(corpus: Record<string, UISpec>): string[] {
  return Object.values(corpus).flatMap((s) => s.components.map((c) => c.type));
}

describe("parity corpus completeness", () => {
  const catalogTypes = coreCatalog.components.map((c) => c.type);

  it("exercises every core catalog type in STRUCTURAL_CORPUS, CHART_CORPUS or overlay.test.ts", () => {
    const covered = new Set<string>([
      ...typesIn(STRUCTURAL_CORPUS),
      ...typesIn(CHART_CORPUS),
      ...OVERLAY_TYPES,
    ]);
    const missing = catalogTypes.filter((t) => !covered.has(t));
    expect(missing).toEqual([]);
  });

  it("keeps the overlay allow-list to real catalog types, so a renamed or removed part cannot linger in it", () => {
    for (const type of OVERLAY_TYPES) {
      expect(catalogTypes, `${type} is not a core catalog type`).toContain(type);
    }
  });
});
