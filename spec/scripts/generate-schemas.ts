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
  KohakuPolicyFileSchema,
  LineageEventRecordSchema,
  PromotionStateSchema,
  SpecPatchSchema,
  UISpecSchema,
} from "@kohaku-ui/spec-core";
import { z } from "zod";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../schemas");
mkdirSync(OUT_DIR, { recursive: true });

/**
 * Counteracts a zod v4 `toJSONSchema({ io: "input" })` heuristic that is too blunt for our case: any node
 * whose value type transitively contains a `transform` anywhere (`isTransforming`, in zod's
 * to-json-schema.js) has its own `.default()` value stripped from the generated schema ("examples/defaults
 * only apply to output type of pipe" — the concern being that a value-changing transform could make a
 * pre-transform default misleading). spec-core's JsonObjectSchema / JsonValueSchema (json.ts) use
 * `z.preprocess` for their depth guard specifically so a *different* zod heuristic resolves the schema's
 * shape through to the real recursive JsonValue definition rather than collapsing it to `{}` -- see
 * json.ts's `withDepthGuard` doc comment -- but that guard's transform is an identity transform (it only
 * ever validates depth; it never changes the value), so the "misleading default" concern does not apply to
 * it, and the stripped `.default()` on a field like a component's `props` (`{}`) or a Spec's `events` (`[]`)
 * is a false positive. Restores it generically for any `.default()`-wrapped node whose default was stripped,
 * by recomputing the same value zod's own (unconditional) default-emission would have written before the
 * heuristic deleted it -- so this self-heals for any current or future JsonValue-typed `.default()`d field,
 * not just the two known ones, and only ever fires when a real `default` value went missing.
 *
 * Rebuilds the object (rather than just assigning `.default`) to put the restored key back in the same
 * "default first" position zod's own unmodified defaultProcessor would have left it in -- it sets `default`
 * on an otherwise-empty object before the field's other properties (type / propertyNames /
 * additionalProperties, merged in later during ref-flattening) are appended, and a plain assignment here
 * would instead append `default` last, which is byte-different (though not semantically different) from that
 * original key order in the committed schema files.
 */
function restoreDefaultsStrippedByTheDepthGuardsTransform(ctx: {
  zodSchema: z.core.$ZodTypes;
  jsonSchema: z.core.JSONSchema.BaseSchema;
}): void {
  const def = ctx.zodSchema._zod.def;
  if (def.type !== "default" || ctx.jsonSchema.default !== undefined) return;
  const defaultValue = JSON.parse(JSON.stringify(def.defaultValue));
  const rest = { ...ctx.jsonSchema };
  for (const key of Object.keys(ctx.jsonSchema)) delete (ctx.jsonSchema as Record<string, unknown>)[key];
  ctx.jsonSchema.default = defaultValue;
  Object.assign(ctx.jsonSchema, rest);
}

const uiSpec = z.toJSONSchema(UISpecSchema, {
  target: "draft-2020-12",
  reused: "inline",
  io: "input",
  override: restoreDefaultsStrippedByTheDepthGuardsTransform,
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
  override: restoreDefaultsStrippedByTheDepthGuardsTransform,
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
  override: restoreDefaultsStrippedByTheDepthGuardsTransform,
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
  override: restoreDefaultsStrippedByTheDepthGuardsTransform,
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
  override: restoreDefaultsStrippedByTheDepthGuardsTransform,
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

const policyFile = z.toJSONSchema(KohakuPolicyFileSchema, {
  target: "draft-2020-12",
  reused: "inline",
  io: "input",
});

writeFileSync(
  join(OUT_DIR, "policy.schema.json"),
  JSON.stringify(
    {
      $id: "https://kohaku-ui.dev/schemas/0.1/policy.schema.json",
      title: "kohaku Policy file",
      description:
        "Declarative Policy-as-Code file (design.md #69): default and per-tenant ComposePolicy/rate-limit/RBAC overrides, loaded by host-core's createPolicyRuntime. Fields that are functions in ComposePolicy (routeTier, fewShot, designSystem, fixedSpecs, l2Smoke, selectComponents, extraRules) cannot be expressed in JSON and are intentionally absent -- they remain the base ComposePolicy supplied by product code.",
      ...policyFile,
    },
    null,
    2,
  ) + "\n",
);

console.log("generated: spec/schemas/policy.schema.json");
