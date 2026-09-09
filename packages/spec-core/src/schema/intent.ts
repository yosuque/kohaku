import { z } from "zod";
import { JsonValueSchema } from "./json.js";

/** A dot-separated lowercase identifier like "sales.quarterly_summary". */
export const CanonicalNameSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);

export const IntentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * A normalized Intent. Both natural-language questions and GUI operations converge on this form.
 * hash is the deterministic hash of canonical + params, the primary component of the cache key.
 */
export const IntentSchema = z.object({
  canonical: CanonicalNameSchema,
  params: z.record(z.string(), JsonValueSchema),
  hash: IntentHashSchema,
});

export type CanonicalIntent = z.infer<typeof IntentSchema>;
