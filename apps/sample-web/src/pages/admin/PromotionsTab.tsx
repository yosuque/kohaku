import type {
  ComponentDraft,
  PromotionAction,
  PromotionCandidateView,
  PromotionPreviewView,
} from "@kohaku-ui/client";
import { createBindingClient } from "@kohaku-ui/data-binding";
import { SandboxFrame } from "@kohaku-ui/sandbox/react";
import { type ComponentNode, type JsonValue, SANDBOX_HTML_TYPE, type UISpec } from "@kohaku-ui/spec-core";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { t as dict, useT } from "../../i18n/ui.js";
import { analytics, promotions } from "../../kohaku/client.js";
import { tenantHeader } from "../../kohaku/tenant.js";
import { useThemeMode } from "../../theme/mode.js";
import { buildTheme } from "../../theme/tokens.js";
import {
  card,
  deniedMessage,
  ErrorBanner,
  Field,
  isKohakuHostError,
  type PushNotice,
  StatusBadge,
  smallButton,
  TextAreaField,
} from "./ui.js";

/**
 * Choices for the promotion status filter (select). "all" means evaluate (automatic nomination); the rest are
 * read-only via GET ?status=. Status values are technical identifiers (untranslated); only the "all" entry
 * gets a dictionary label at render time.
 */
const STATUS_FILTERS = [
  "all",
  "in_use",
  "candidate",
  "in_review",
  "changes_requested",
  "approved",
  "published",
  "rejected",
  "withdrawn",
] as const;

type PromotionActionKind = "approve" | "reject" | "withdraw" | "requestChanges";

export function PromotionsTab({ onNotice }: { onNotice: PushNotice }): ReactNode {
  const [candidates, setCandidates] = useState<PromotionCandidateView[]>([]);
  const [busy, setBusy] = useState(false);
  // The promotion-nomination threshold behind the "N or more uses" empty-state copy, sourced from
  // GET /analytics/summary's promotionPolicy rather than a literal so it cannot drift from the server's
  // actual policy. null until loaded (or if the host does not bundle it), in which case a generic
  // number-free message is shown instead of guessing a number.
  const [promotionMinUses, setPromotionMinUses] = useState<number | null>(null);
  const t = useT();
  // Status filter (added for the changes-requested workflow). "all" digs up candidates via promotions.evaluate() (with automatic nominate).
  // A specific status narrows by state via promotions.list({status}) (read-only, no side effects).
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const reload = useCallback(() => {
    const isAll = statusFilter === "all";
    void (isAll ? promotions.evaluate() : promotions.list({ status: statusFilter }))
      .then(setCandidates)
      .catch((e: unknown) => {
        // viewer does not have promotion.evaluate (but does have promotion.list), so only "all" can be denied.
        const denied = isKohakuHostError(e)
          ? deniedMessage(e, isAll ? dict().admin.promotions.opEvaluate : dict().admin.promotions.opList)
          : null;
        if (denied != null) onNotice(denied, "error");
        setCandidates([]);
      });
    void analytics.summary().then((s) => setPromotionMinUses(s.promotionPolicy?.promotionMinUses ?? null));
  }, [onNotice, statusFilter]);
  useEffect(reload, [reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, color: "var(--app-muted, #6b7280)", flex: 1, minWidth: 280 }}>
          {t.admin.promotions.description}
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--app-muted, #6b7280)",
          }}
        >
          {t.admin.promotions.statusLabel}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              border: "1px solid var(--app-border, #e5e7eb)",
              borderRadius: 6,
              padding: "6px 9px",
              fontSize: 12.5,
            }}
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? t.admin.promotions.statusAllOption : value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {candidates.length === 0 && (
        <div style={card}>
          {statusFilter === "all"
            ? promotionMinUses != null
              ? t.admin.promotions.emptyAll(promotionMinUses)
              : t.admin.emptyDefault
            : t.admin.promotions.emptyStatus(statusFilter)}
        </div>
      )}
      {candidates.map((candidate) => (
        <PromotionCard
          key={candidate.artifactId}
          candidate={candidate}
          busy={busy}
          onAction={async (kind, draft) => {
            setBusy(true);
            try {
              if (kind === "requestChanges") {
                await requestChanges(candidate);
                onNotice(dict().admin.promotions.requestChangesNotice);
                reload();
                return;
              }
              // Approve/reject/withdraw are all promoted to first-class named routes in host-rest.
              // The approve draft is already the wire form including paramsJsonSchema / queryTemplate.
              await performPromotionAction(candidate, kind, draft);
              onNotice(successNoticeFor(kind, candidate, draft!));
              reload();
            } catch (e) {
              // For 403 CAPABILITY_DENIED (viewer, etc.), show a role-oriented explanation in a red banner. Others are treated as failures.
              // requestChanges does not get this treatment: its own failures always fall through to failedNotice below.
              if (kind !== "requestChanges" && isKohakuHostError(e)) {
                const denied = deniedMessage(e, opLabelFor(kind));
                if (denied != null) {
                  onNotice(denied, "error");
                  return;
                }
              }
              onNotice(
                dict().admin.promotions.failedNotice(e instanceof Error ? e.message : String(e)),
                "error",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      ))}
    </div>
  );
}

/** Runs one of the three named promotion transitions via the typed SDK. Throws KohakuHostError on failure. */
function performPromotionAction(
  candidate: PromotionCandidateView,
  kind: Exclude<PromotionActionKind, "requestChanges">,
  draft?: ComponentDraft,
): Promise<PromotionCandidateView> {
  switch (kind) {
    case "approve":
      return promotions.approve(candidate.artifactId, draft!);
    case "reject":
      return promotions.reject(candidate.artifactId);
    case "withdraw":
      return promotions.withdraw(candidate.artifactId);
  }
}

/** The governance-operation label (for deniedMessage's role explanation), keyed by action kind. */
function opLabelFor(kind: Exclude<PromotionActionKind, "requestChanges">): string {
  const labels: Record<Exclude<PromotionActionKind, "requestChanges">, string> = {
    approve: dict().admin.promotions.opApprove,
    withdraw: dict().admin.promotions.opWithdraw,
    reject: dict().admin.promotions.opReject,
  };
  return labels[kind];
}

/** The success notice text, keyed by action kind. approve depends on the pre-action status (resubmit vs. first promotion), so it is a function. */
function successNoticeFor(
  kind: Exclude<PromotionActionKind, "requestChanges">,
  candidate: PromotionCandidateView,
  draft: ComponentDraft,
): string {
  if (kind === "approve") {
    return candidate.status === "changes_requested"
      ? dict().admin.promotions.reApprovedNotice(draft.componentType, draft.version)
      : dict().admin.promotions.promotedNotice(draft.componentType, draft.version, draft.intentName);
  }
  const notices: Record<"withdraw" | "reject", string> = {
    withdraw: dict().admin.promotions.withdrawnNotice,
    reject: dict().admin.promotions.rejectedNotice,
  };
  return notices[kind];
}

/**
 * Transitions a candidate to changes_requested (sent back) (for demonstrating the changes-requested recovery path). Via the generic actions route,
 * candidate takes 2 steps: review.start → review.requestChanges; in_review takes 1 step: review.requestChanges.
 * Any step failure (including CAPABILITY_DENIED) throws as-is — unlike approve/reject/withdraw, the caller does not
 * apply deniedMessage's role explanation here.
 */
async function requestChanges(candidate: PromotionCandidateView): Promise<void> {
  const steps: PromotionAction[] =
    candidate.status === "candidate"
      ? [{ kind: "review.start" }, { kind: "review.requestChanges", comment: "Demo: request changes" }]
      : [{ kind: "review.requestChanges", comment: "Demo: request changes" }];
  for (const action of steps) {
    await promotions.act(candidate.artifactId, action);
  }
}

interface DraftForm {
  componentType: string;
  version: string;
  intentName: string;
  description: string;
  /** Inputs of the collapsible "schema and data wiring" section (all JSON text / select values) */
  paramsJsonSchema: string;
  queryPath: string;
  fixedParams: string;
  paramMap: string;
}

/** Static candidates for queryTemplate.path (paths supported by sample-api's query source). */
const QUERY_PATHS = ["", "trend", "summary", "records", "kpi", "targets"] as const;

/**
 * Prefill equivalent to the current trend (paramsJsonSchema / queryTemplate).
 * The 2026 default mirrors the server's demo "current period" (apps/sample-api/src/intents/vocab.ts's
 * DEMO_FISCAL_YEAR). Left as a literal because the web app has no dependency on server code (AGENTS.md) and
 * facet-views.json (the data it does import) does not carry a default value, only the FY option list.
 */
const TREND_PARAMS_SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: {
      fiscalYear: { type: "integer", default: 2026 },
      region: { type: "string", enum: ["japan", "north_america", "europe", "apac"] },
    },
  },
  null,
  2,
);
const TREND_FIXED_PARAMS = JSON.stringify({ metric: "revenue", granularity: "month" }, null, 2);
const TREND_PARAM_MAP = JSON.stringify({ fiscalYear: "fy", region: "region" }, null, 2);

/**
 * Converts a DraftForm (JSON text input) into the wire-form draft carried in the approve body.
 * Empty fields are omitted (delegated to the product default, compatible with the old promoted.json). Invalid JSON returns an error and blocks submission.
 */
function buildDraftPayload(
  draft: DraftForm,
): { ok: true; payload: ComponentDraft } | { ok: false; error: string } {
  const parseOptional = (label: string, text: string): { value: unknown } | { error: string } => {
    if (text.trim() === "") return { value: undefined };
    try {
      return { value: JSON.parse(text) };
    } catch (e) {
      return {
        error: dict().admin.promotions.invalidJson(label, e instanceof Error ? e.message : String(e)),
      };
    }
  };
  const params = parseOptional("paramsJsonSchema", draft.paramsJsonSchema);
  if ("error" in params) return { ok: false, error: params.error };
  const fixed = parseOptional("fixedParams", draft.fixedParams);
  if ("error" in fixed) return { ok: false, error: fixed.error };
  const map = parseOptional("paramMap", draft.paramMap);
  if ("error" in map) return { ok: false, error: map.error };

  const payload: ComponentDraft = {
    componentType: draft.componentType,
    version: draft.version,
    intentName: draft.intentName,
    description: draft.description,
    ...(params.value !== undefined ? { paramsJsonSchema: params.value } : {}),
    ...(draft.queryPath.trim() !== ""
      ? {
          queryTemplate: {
            path: draft.queryPath.trim(),
            ...(fixed.value !== undefined ? { fixedParams: fixed.value as Record<string, string> } : {}),
            ...(map.value !== undefined ? { paramMap: map.value as Record<string, string> } : {}),
          },
        }
      : {}),
  };
  return { ok: true, payload };
}

function PromotionCard(props: {
  candidate: PromotionCandidateView;
  busy: boolean;
  onAction: (kind: PromotionActionKind, draft?: ComponentDraft) => Promise<void>;
}): ReactNode {
  const { candidate } = props;
  const t = useT();
  // Detect the heatmap request in either language (the demo suggestion is English by default, but a JA i18n session may send Japanese).
  const isHeatmap = /ヒートマップ|heatmap/i.test(candidate.request ?? "");
  const [draft, setDraft] = useState<DraftForm>({
    componentType: isHeatmap ? "sales.calendarHeatmap" : "sales.customViz1",
    version: "1.0.0",
    intentName: isHeatmap ? "sales.calendar_heatmap" : "sales.custom_viz_1",
    description: isHeatmap
      ? "Display sales as a monthly calendar heatmap"
      : (candidate.request ?? "Promoted visualization part"),
    // The detail fields are prefilled with the current trend equivalent (approving without opening the editor still submits this same wiring).
    paramsJsonSchema: TREND_PARAMS_SCHEMA,
    queryPath: "trend",
    fixedParams: TREND_FIXED_PARAMS,
    paramMap: TREND_PARAM_MAP,
  });
  const terminal = ["published", "rejected", "withdrawn"].includes(candidate.status);
  // changes_requested (sent back) is non-terminal, and approval is restored as the "resubmit and approve" path.
  const isChangesRequested = candidate.status === "changes_requested";
  // "Request changes (send back)" is offered only for candidate / in_review (drops to changes_requested via actions).
  const canRequestChanges = candidate.status === "candidate" || candidate.status === "in_review";
  const built = buildDraftPayload(draft);

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "var(--app-muted, #6b7280)" }}
        >
          {candidate.artifactId}
        </span>
        <StatusBadge status={candidate.status} />
        <span style={{ fontSize: 12.5, color: "var(--app-subtle, #475569)" }}>
          {t.admin.promotions.usesSessions(candidate.uses, candidate.sessions)}
        </span>
        {candidate.verdict != null && (
          <span style={{ fontSize: 12, color: candidate.verdict.pass ? "#166534" : "#991b1b" }}>
            judge: {candidate.verdict.pass ? "PASS" : "FAIL"}({candidate.verdict.score})
          </span>
        )}
      </div>
      {isChangesRequested && (
        <div
          style={{
            background: "#fef3c7",
            color: "#92400e",
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 12,
            margin: "8px 0",
          }}
        >
          {t.admin.promotions.changesRequestedBanner}
        </div>
      )}
      {candidate.request != null && (
        <div style={{ fontSize: 14, margin: "8px 0", fontWeight: 600 }}>「{candidate.request}」</div>
      )}
      {candidate.html != null && (
        <details style={{ fontSize: 12, margin: "6px 0" }}>
          <summary style={{ cursor: "pointer", color: "var(--app-muted, #6b7280)" }}>
            {t.admin.promotions.generatedHtml((candidate.html.length / 1024).toFixed(1))}
          </summary>
          <pre
            style={{
              background: "#0f172a",
              color: "#e2e8f0",
              borderRadius: 8,
              padding: 12,
              maxHeight: 280,
              overflow: "auto",
              fontSize: 11,
            }}
          >
            {candidate.html}
          </pre>
        </details>
      )}
      {candidate.html != null && <PromotionPreview artifactId={candidate.artifactId} />}
      {!terminal && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
          <DraftEditor draft={draft} setDraft={setDraft} />
          {!built.ok && <ErrorBanner text={built.error} size="sm" role="alert" />}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              disabled={props.busy || !built.ok}
              onClick={() => built.ok && void props.onAction("approve", built.payload)}
              style={{
                ...smallButton,
                background: built.ok ? "var(--app-primary, #4f46e5)" : "#c7d2fe",
                color: "#fff",
                border: "none",
                padding: "8px 18px",
                cursor: built.ok && !props.busy ? "pointer" : "not-allowed",
              }}
            >
              {isChangesRequested
                ? t.admin.promotions.approveResubmitButton
                : t.admin.promotions.approveButton}
            </button>
            {canRequestChanges && (
              <button
                type="button"
                disabled={props.busy}
                onClick={() => void props.onAction("requestChanges")}
                style={{ ...smallButton, borderColor: "#fbbf24", color: "#92400e" }}
              >
                {t.admin.promotions.requestChangesButton}
              </button>
            )}
            {isChangesRequested ? (
              // A reject from changes_requested is outside the service layer's recovery scope (only approve recovers), so
              // we do not offer a reject that would 422 on a mis-operation, and consolidate abandonment into withdraw.
              <button
                type="button"
                disabled={props.busy}
                onClick={() => void props.onAction("withdraw")}
                style={{ ...smallButton, borderColor: "#fca5a5", color: "#991b1b" }}
              >
                {t.admin.promotions.withdrawButton}
              </button>
            ) : (
              <button
                type="button"
                disabled={props.busy}
                onClick={() => void props.onAction("reject")}
                style={smallButton}
              >
                {t.admin.promotions.rejectButton}
              </button>
            )}
          </div>
        </div>
      )}
      {candidate.status === "published" && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            disabled={props.busy}
            onClick={() => void props.onAction("withdraw")}
            style={{ ...smallButton, borderColor: "#fca5a5", color: "#991b1b" }}
          >
            {t.admin.promotions.unpublishButton}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The draft-editing form (componentType/version/intentName/description + the collapsible schema/query-wiring
 * section). Pure presentation — state stays in PromotionCard (extracted for readability, proposal 18).
 */
function DraftEditor(props: { draft: DraftForm; setDraft: (draft: DraftForm) => void }): ReactNode {
  const { draft, setDraft } = props;
  const t = useT();
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
        label={t.admin.promotions.descriptionFieldLabel}
        value={draft.description}
        onChange={(v) => setDraft({ ...draft, description: v })}
      />

      <details style={{ fontSize: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--app-muted, #6b7280)", padding: "2px 0" }}>
          {t.admin.promotions.schemaDetailsSummary}
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
          <TextAreaField
            label={t.admin.promotions.paramsJsonSchemaLabel}
            value={draft.paramsJsonSchema}
            rows={7}
            onChange={(v) => setDraft({ ...draft, paramsJsonSchema: v })}
          />
          <label
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 3,
              fontSize: 11.5,
              color: "var(--app-muted, #6b7280)",
            }}
          >
            {t.admin.promotions.queryPathLabel}
            <select
              value={draft.queryPath}
              onChange={(e) => setDraft({ ...draft, queryPath: e.target.value })}
              style={{
                border: "1px solid var(--app-border, #e5e7eb)",
                borderRadius: 6,
                padding: "6px 9px",
                fontSize: 12.5,
              }}
            >
              {QUERY_PATHS.map((p) => (
                <option key={p} value={p}>
                  {p === "" ? t.admin.promotions.queryPathDefaultOption : p}
                </option>
              ))}
            </select>
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <TextAreaField
              label={t.admin.promotions.fixedParamsLabel}
              value={draft.fixedParams}
              rows={4}
              onChange={(v) => setDraft({ ...draft, fixedParams: v })}
            />
            <TextAreaField
              label={t.admin.promotions.paramMapLabel}
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

/**
 * Preview of a promotion candidate: mounts the recorded artifact (the very thing under review) directly in the same
 * SandboxFrame (isolated iframe, network-blocked) as the chat surface. Since it does not re-compose,
 * the identity between what is displayed and what is approved is guaranteed by sha256. Data is proxy-resolved by the parent bridge
 * using a read capability issued by the preview API, limited to the single generation-time ref (the capability never enters the iframe).
 */
function PromotionPreview({ artifactId }: { artifactId: string }): ReactNode {
  const [material, setMaterial] = useState<PromotionPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const t = useT();
  // Inject the same theme as the production display (SpecSurface) for review — the approval decision is made on the actual appearance.
  const { mode } = useThemeMode();
  const theme = useMemo(() => buildTheme(mode), [mode]);

  const binding = useMemo(
    () =>
      material?.capability != null
        ? createBindingClient({
            baseUrl: "/api/kohaku",
            capability: material.capability,
            headers: tenantHeader,
          })
        : null,
    [material?.capability],
  );

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const preview = await promotions.preview(artifactId);
      if (preview == null) {
        setError(dict().admin.promotions.previewMalformed);
        return;
      }
      setMaterial(preview);
    } catch (e) {
      const denied = isKohakuHostError(e) ? deniedMessage(e, dict().admin.promotions.opPreview) : null;
      setError(
        denied ?? dict().admin.promotions.previewFetchFailed(e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setLoading(false);
    }
  };

  if (material == null) {
    return (
      <div style={{ margin: "6px 0" }}>
        <button type="button" disabled={loading} onClick={() => void load()} style={smallButton}>
          {loading ? t.admin.promotions.previewLoading : t.admin.promotions.previewButton}
        </button>
        {error != null && <ErrorBanner text={error} size="sm" role="alert" style={{ marginTop: 6 }} />}
      </div>
    );
  }

  // Maps the very thing under review into a sandbox node. It does not declare events (= all events from the guest
  // are blocked), so the preview is a read-only view.
  const node: ComponentNode = {
    id: `preview-${artifactId}`,
    type: SANDBOX_HTML_TYPE,
    props: {},
    artifact: { inline: material.html, sha256: material.sha256 },
    ...(material.ref != null ? { data: { $ref: material.ref } } : {}),
  };
  const spec: UISpec = {
    kohaku: "0.1",
    intent: { canonical: "admin.promotionPreview", params: {}, hash: "sha256:" + "0".repeat(64) },
    dataVersion: "preview",
    components: [node],
    events: [],
    provenance: { tier: "L2", composedBy: "admin-preview", cache: "bypass" },
  };

  return (
    <div style={{ margin: "8px 0", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setMaterial(null)} style={smallButton}>
          {t.admin.promotions.closePreview}
        </button>
        {material.ref == null && (
          <span style={{ fontSize: 12, color: "#92400e" }}>{t.admin.promotions.previewNoRefWarning}</span>
        )}
      </div>
      <div style={{ border: "1px dashed var(--app-border, #e5e7eb)", borderRadius: 8, padding: 10 }}>
        <SandboxFrame
          node={node}
          spec={spec}
          theme={theme}
          bridge={{
            resolveBinding: async (ref) => {
              if (binding == null) throw new Error("This candidate has no recorded data reference");
              return (await binding.resolve(ref)) as unknown as JsonValue;
            },
            // Unreachable because events are not declared (the allowlist blocks it).
            onEvent: () => {},
            onTelemetry: (event) => {
              // Does not send component.used (does not mix the preview into the promotion's usage count).
              if (event.kind === "error") {
                console.warn("[kohaku] promotion preview render error", artifactId, event);
              }
            },
          }}
        />
      </div>
    </div>
  );
}
