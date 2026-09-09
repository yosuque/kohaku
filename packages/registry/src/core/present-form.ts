import { z } from "zod";
import { defineComponent } from "../define.js";

/**
 * Schema for a single form field. renderer-react's form.tsx type-only imports and shares it
 * (removing the type duplication; the dependency direction is forward — registry → renderer-react,
 * not the reverse — so nothing is pulled into the bundle).
 * A string in `options` is treated as equivalent to `{ value, label }` (backward compatible).
 */
const FieldSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  type: z
    .enum(["text", "number", "select", "date", "boolean", "textarea", "radio", "multiselect", "email", "url"])
    .default("text"),
  required: z.boolean().optional(),
  /** Choices for select / radio / multiselect. A string is equivalent to `{ value:label }` (backward compatible). */
  options: z.array(z.union([z.string(), z.object({ value: z.string(), label: z.string() })])).optional(),
  placeholder: z.string().optional(),
  /** Supplementary description. Linked to the input via aria-describedby. */
  helpText: z.string().optional(),
  /**
   * Initial value. The row value from node.data takes precedence; this is used only when it is absent
   * (row value > defaultValue). multiselect expects string[]; everything else expects a scalar
   * (the representable subset of JsonValue).
   */
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  /** Lower bound / upper bound / step for number / date. For number, also used for pre-submit validation (min/max). */
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** Input pattern (HTML pattern) for text / email / url / number. Matched as a full match in declarative validation too. */
  pattern: z.string().optional(),
  /** Validation: minimum / maximum length (string values of text / textarea / email / url / select / radio). */
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
  /**
   * Message shown on a validation failure (defaults to a per-type message when unspecified). One
   * message per field: the same message is shown regardless of which constraint is violated
   * (functions are disallowed, keeping this to a JSON representation that is safe for LLM generation).
   */
  message: z.string().optional(),
});

/** Type of a single form field (the single definition that renderer-react references via a type-only import). */
export type PresentFormField = z.infer<typeof FieldSchema>;

export const presentForm = defineComponent({
  type: "presentForm",
  version: "1.2.0",
  description:
    "Input form. Fires an action on the submit event. Writes go component → API directly " +
    "(with a capability token) and never pass through the LLM's context. " +
    "Field types are text / number / select / date / boolean / textarea / radio / multiselect / email / url. " +
    "Declaring required / minLength / maxLength / pattern / min / max on a field validates before " +
    "submit; on a violation it does not send and shows an aggregate error and inline errors (the message can be overridden via message). " +
    'Giving data ($ref) prefills the first row as initial values, turning it into an "edit this record" form.',
  propsSchema: z.object({
    fields: z.array(FieldSchema).min(1),
    submitLabel: z.string().optional(),
    /** Message shown on successful submission (defaults to the renderer's message when unspecified). */
    successMessage: z.string().optional(),
    /** Name of the target action (maps to a DomainPort operation name / the direct write path). */
    action: z.string().min(1),
  }),
  // data is "optional": when provided, prefill initial values from the first row (edit form); when absent, a new-entry form.
  capabilities: { events: ["submit"], data: "optional", children: "none", editable: true },
  fallback: {
    type: "presentMarkdown",
    mapProps: () => ({ markdown: "(This form is not available on this surface)" }),
  },
});
