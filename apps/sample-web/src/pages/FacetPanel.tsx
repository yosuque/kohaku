import type { JsonObject } from "@kohaku-ui/spec-core";
import type { ReactNode } from "react";
import { useLang } from "../i18n/lang.js";
import { useT } from "../i18n/ui.js";
import { coerceFacetValue, DEFAULT_VIEW, FACET_VIEWS, facetLabel } from "./facet-views.js";

/**
 * The input surface of the GUI. It uses the facet descriptors (facet-views.json) as the single source and holds no
 * hand-written views / options / coerce (the former VIEWS / REGION / QUARTER / coerce were removed). Facet operations
 * merge into normalized Intents as GuiActions (heading to the same Composition Service as natural language).
 * Labels follow the UI language via the bilingual overlays baked into facet-views.json (facetLabel).
 */
export function FacetPanel(props: {
  view: string;
  params: JsonObject;
  onChange: (intent: string, params: JsonObject) => void;
}): ReactNode {
  const current = FACET_VIEWS.find((v) => v.intent === props.view) ?? DEFAULT_VIEW;
  const { lang } = useLang();
  const t = useT();

  return (
    <aside
      style={{
        width: 230,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 18,
        padding: 16,
        background: "var(--app-elevated, #fff)",
        borderRight: "1px solid var(--app-border, #e5e7eb)",
        minHeight: "100%",
      }}
    >
      <section>
        <div style={sectionLabel}>{t.dashboard.viewSection}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {FACET_VIEWS.map((view) => (
            <label
              key={view.intent}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                fontSize: 13.5,
                padding: "5px 8px",
                borderRadius: 6,
                cursor: "pointer",
                background:
                  view.intent === current.intent ? "var(--app-primary-weak, #eef2ff)" : "transparent",
                color:
                  view.intent === current.intent ? "var(--app-primary, #4f46e5)" : "var(--app-text, #1a1a2e)",
                fontWeight: view.intent === current.intent ? 650 : 400,
              }}
            >
              <input
                type="radio"
                name="view"
                checked={view.intent === current.intent}
                onChange={() => props.onChange(view.intent, {})}
              />
              {facetLabel(view, lang)}
            </label>
          ))}
        </div>
      </section>

      <section>
        <div style={sectionLabel}>{t.dashboard.filtersSection}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {current.facets.map((facet) => (
            <label
              key={facet.key}
              style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12.5 }}
            >
              <span style={{ color: "var(--app-muted, #6b7280)", fontWeight: 600 }}>
                {facetLabel(facet, lang)}
              </span>
              <select
                value={String(props.params[facet.key] ?? "")}
                onChange={(e) => {
                  const next = { ...props.params } as JsonObject;
                  if (e.target.value === "") {
                    delete next[facet.key];
                  } else {
                    next[facet.key] = coerceFacetValue(facet.valueType, e.target.value);
                  }
                  props.onChange(current.intent, next);
                }}
                style={{
                  border: "1px solid var(--app-border, #e5e7eb)",
                  borderRadius: 6,
                  padding: "6px 8px",
                  fontSize: 13,
                  background: "var(--app-elevated, #fff)",
                  color: "var(--app-text, #1a1a2e)",
                }}
              >
                {facet.allowEmpty != null && (
                  <option value="">{facet.allowEmptyLabels?.[lang] ?? facet.allowEmpty}</option>
                )}
                {facet.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {facetLabel(opt, lang)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>
    </aside>
  );
}

const sectionLabel = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--app-muted, #9ca3af)",
  letterSpacing: 1,
  textTransform: "uppercase",
  marginBottom: 8,
} as const;
