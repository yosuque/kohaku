import { z } from "zod";
import { JsonObjectSchema } from "./json.js";
import { UISpecSchema } from "./spec.js";

/**
 * Runtime counterpart of ports.ts's Principal, scoped to this file: the port interface has no independent
 * identity beyond {id, name?, roles?}, so a schema here is enough to validate the Principal embedded in a
 * persisted governance record (FixationRecord.approver).
 */
const PersistedPrincipalSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  roles: z.array(z.string()).optional(),
});

/**
 * Runtime counterpart of ports.ts's FixationRecord, validated at the storage boundary:
 * `StoragePort.getFixation` returns plain JSON cast to this type with no runtime guarantee,
 * so a corrupted or hand-edited record (a truncated write, a manual edit to fixations.json) must be caught
 * before a broken `pinnedSpec` reaches a renderer. Both lineage's Fixations service (unfixate / invalidate /
 * refreshFingerprint) and composer's materializeFixation run the record they read through this schema and
 * treat a validation failure as "the fixation does not exist" (falling back to the fresh-compose path),
 * never surfacing the corruption to the delivery path itself.
 */
export const FixationRecordSchema = z.object({
  intentHash: z.string(),
  canonical: z.string(),
  structureHash: z.string(),
  pinnedSpec: UISpecSchema,
  fixatedAt: z.string(),
  approver: PersistedPrincipalSchema,
  /** The catalog fingerprint at fixation time (optional = compatible with pre-fingerprint records). */
  catalogFingerprint: z.string().optional(),
  /** The tenant that owns the fixation (optional = tenant-neutral / legacy). */
  tenant: z.string().optional(),
  /** A per-write monotonic token (optional = compatible with records that predate it; see ports.ts). */
  revision: z.string().optional(),
});

/**
 * Runtime counterpart of ports.ts's PromotionState, validated at the storage boundary, the same
 * way as FixationRecordSchema: lineage's CandidateStore.load runs a `getPromotionState` result through this
 * schema and treats a validation failure as "no promotion state" (the candidate falls back to `in_use`,
 * exactly the same default as a real absence).
 *
 * `data` stays a loose JSON object (JsonObjectSchema) rather than a closed shape: it carries a grab-bag of
 * governance fields (verdict / draft / request) plus, once a candidate reaches "published",
 * candidate-store.ts's `persist` additionally duplicates a published projection (html / sha256 / ref /
 * componentType) onto it. Closing this shape would need updating in lockstep with every field
 * candidate-store.ts starts copying onto `data`; a loose object still catches the failure mode this schema
 * exists for (a corrupted/truncated JSON record) without that maintenance burden.
 */
export const PromotionStateSchema = z.object({
  artifactId: z.string(),
  status: z.string(),
  updatedAt: z.string(),
  data: JsonObjectSchema,
  /** The tenant that owns the promotion state (optional = tenant-neutral / legacy). */
  tenant: z.string().optional(),
});

/**
 * Runtime counterpart of ports.ts's LineageEventRecord. Deliberately loose on `type` (a plain string, not an
 * enum of known LineageEventType values) and `payload` (JsonObjectSchema, not a per-event-type shape): the
 * event vocabulary is owned by @kohaku-ui/lineage (spec-core must not know it — dependency direction), and
 * lineage is an append-only audit log where an event type this schema has never seen must not become a
 * validation failure. Exported for JSON-Schema generation and general availability; unlike
 * FixationRecordSchema / PromotionStateSchema, it is not currently wired into a lineage read-boundary check
 * (listLineage has no single "does this event exist" fallback to degrade to).
 */
export const LineageEventRecordSchema = z.object({
  id: z.string(),
  ts: z.string(),
  actor: z.object({
    kind: z.enum(["user", "model", "system"]),
    id: z.string().optional(),
    model: z.string().optional(),
  }),
  type: z.string(),
  payload: JsonObjectSchema,
  tenant: z.string().optional(),
});
