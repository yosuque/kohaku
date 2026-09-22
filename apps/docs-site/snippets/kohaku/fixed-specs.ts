import type { FixedSpecSource } from "@kohaku-ui/composer";
import { SPEC_VERSION, type UISpec } from "@kohaku-ui/spec-core";

/** L0: the Intents listed here never reach the model; the Spec is built deterministically from the refs. */
export const fixedSpecs: FixedSpecSource = {
  async lookup(intent) {
    if (intent.canonical !== "sales.summary") return null;
    return (i, refs): UISpec => ({
      kohaku: SPEC_VERSION,
      intent: i,
      dataVersion: "template", // the composer overwrites this (and provenance.cache) before caching
      components: [
        { id: "root", type: "layout.stack", props: { direction: "vertical" }, children: ["title", "table"] },
        { id: "title", type: "text.heading", props: { level: 2, text: "Revenue by region" } },
        {
          id: "table",
          type: "presentSpreadsheet",
          props: { editable: false },
          data: { $ref: refs[0]?.uri ?? "" },
        },
      ],
      events: [],
      provenance: { tier: "L0", composedBy: "fixed-specs", cache: "miss" },
    });
  },
};
