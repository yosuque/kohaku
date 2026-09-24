import type { ReactNode } from "react";
import { useAdmin } from "../../context.js";
import { V } from "../../theme.js";
import { Field, selectStyle, TextAreaField } from "../../ui.js";
import type { DraftForm } from "./draft.js";

export interface PromotionDraftEditorProps {
  draft: DraftForm;
  setDraft: (draft: DraftForm) => void;
  /** Choices for queryTemplate.path ("" = the product default wiring). */
  queryPaths: readonly string[];
}

/** The draft-editing form (componentType / version / intentName / description + collapsible schema & query wiring). Pure presentation. */
export function PromotionDraftEditor({ draft, setDraft, queryPaths }: PromotionDraftEditorProps): ReactNode {
  const { messages: t } = useAdmin();
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 8 }}>
        <Field
          label="componentType"
          value={draft.componentType}
          onChange={(v) => setDraft({ ...draft, componentType: v })}
        />
        <Field label="version" value={draft.version} onChange={(v) => setDraft({ ...draft, version: v })} />
      </div>
      <Field
        label="intentName"
        value={draft.intentName}
        onChange={(v) => setDraft({ ...draft, intentName: v })}
      />
      <Field
        label={t.promotions.descriptionFieldLabel}
        value={draft.description}
        onChange={(v) => setDraft({ ...draft, description: v })}
      />
      <details style={{ fontSize: 12 }}>
        <summary style={{ cursor: "pointer", color: V.muted, padding: "2px 0" }}>
          {t.promotions.schemaDetailsSummary}
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          <TextAreaField
            label={t.promotions.paramsJsonSchemaLabel}
            value={draft.paramsJsonSchema}
            rows={7}
            onChange={(v) => setDraft({ ...draft, paramsJsonSchema: v })}
          />
          <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11.5, color: V.muted }}>
            {t.promotions.queryPathLabel}
            <select
              value={draft.queryPath}
              onChange={(e) => setDraft({ ...draft, queryPath: e.target.value })}
              style={selectStyle}
            >
              {queryPaths.map((p) => (
                <option key={p} value={p}>
                  {p === "" ? t.promotions.queryPathDefaultOption : p}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <TextAreaField
              label={t.promotions.fixedParamsLabel}
              value={draft.fixedParams}
              rows={4}
              onChange={(v) => setDraft({ ...draft, fixedParams: v })}
            />
            <TextAreaField
              label={t.promotions.paramMapLabel}
              value={draft.paramMap}
              rows={4}
              onChange={(v) => setDraft({ ...draft, paramMap: v })}
            />
          </div>
        </div>
      </details>
    </>
  );
}
