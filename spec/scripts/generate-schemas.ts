/**
 * Generates JSON Schema from spec-core's Zod schemas and checks it in.
 * Run: pnpm --filter @kohaku-ui/spec run generate-schemas
 * (Zod is authoritative; JSON Schema is derived — drift is resolved by re-running this script.)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FixationRecordSchema,
  LineageEventRecordSchema,
  PromotionStateSchema,
  SpecPatchSchema,
  UISpecSchema,
} from "@kohaku-ui/spec-core";
import { z } from "zod";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../schemas");
mkdirSync(OUT_DIR, { recursive: true });

const uiSpec = z.toJSONSchema(UISpecSchema, {
  target: "draft-2020-12",
  reused: "inline",
  io: "input",
});

writeFileSync(
  join(OUT_DIR, "ui-spec.schema.json"),
  JSON.stringify(
    {
      $id: "https://kohaku-ui.dev/schemas/0.1/ui-spec.schema.json",
      title: "kohaku UI Spec v0.1",
      description:
        "Declarative UI Spec (Kohaku Protocol v0.1). Structural validation (unique IDs, required root, acyclicity, etc.) is out of scope for this schema and is handled by validateSpecStructure in the reference implementation @kohaku-ui/spec-core.",
      ...uiSpec,
    },
    null,
    2,
  ) + "\n",
);

console.log("generated: spec/schemas/ui-spec.schema.json");

const specPatch = z.toJSONSchema(SpecPatchSchema, {
  target: "draft-2020-12",
  reused: "inline",
  io: "input",
});

writeFileSync(
  join(OUT_DIR, "spec-patch.schema.json"),
  JSON.stringify(
    {
      $id: "https://kohaku-ui.dev/schemas/0.1/spec-patch.schema.json",
      title: "kohaku Spec Patch v0.1",
      description:
        "SpecPatch (incremental updates via per-ID upsert/remove; used for streaming and the interaction loop). Structural validation of a patch on its own is out of scope for this schema and is handled by validateSpecStructure on the applied result inside applyPatch.",
      ...specPatch,
    },
    null,
    2,
  ) + "\n",
);

console.log("generated: spec/schemas/spec-patch.schema.json");

const fixationRecord = z.toJSONSchema(FixationRecordSchema, {
  target: "draft-2020-12",
  reused: "inline",
  io: "input",
});

writeFileSync(
  join(OUT_DIR, "fixation-record.schema.json"),
  JSON.stringify(
    {
      $id: "https://kohaku-ui.dev/schemas/0.1/fixation-record.schema.json",
      title: "kohaku FixationRecord",
      description:
        "Persisted L1->L0 fixation record (StoragePort.getFixation / putFixation). Reference implementation of the storage-boundary validation described in docs/design.md; not itself part of the wire protocol between a Renderer and a host.",
      ...fixationRecord,
    },
    null,
    2,
  ) + "\n",
);

console.log("generated: spec/schemas/fixation-record.schema.json");

const promotionState = z.toJSONSchema(PromotionStateSchema, {
  target: "draft-2020-12",
  reused: "inline",
  io: "input",
});

writeFileSync(
  join(OUT_DIR, "promotion-state.schema.json"),
  JSON.stringify(
    {
      $id: "https://kohaku-ui.dev/schemas/0.1/promotion-state.schema.json",
      title: "kohaku PromotionState",
      description:
        "Persisted promotion (L2->L1) state snapshot (StoragePort.getPromotionState / putPromotionState). `data` is intentionally left as a loose JSON object (see PromotionStateSchema's doc comment).",
      ...promotionState,
    },
    null,
    2,
  ) + "\n",
);

console.log("generated: spec/schemas/promotion-state.schema.json");

const lineageEventRecord = z.toJSONSchema(LineageEventRecordSchema, {
  target: "draft-2020-12",
  reused: "inline",
  io: "input",
});

writeFileSync(
  join(OUT_DIR, "lineage-event-record.schema.json"),
  JSON.stringify(
    {
      $id: "https://kohaku-ui.dev/schemas/0.1/lineage-event-record.schema.json",
      title: "kohaku LineageEventRecord",
      description:
        "Persisted lineage (audit) event (StoragePort.appendLineage / listLineage). `type` / `payload` are intentionally loose: the event vocabulary is owned by @kohaku-ui/lineage, not spec-core.",
      ...lineageEventRecord,
    },
    null,
    2,
  ) + "\n",
);

console.log("generated: spec/schemas/lineage-event-record.schema.json");
