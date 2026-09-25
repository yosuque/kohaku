import { type BindingClient, type BindingClientConfig, createBindingClient } from "@kohaku-ui/data-binding";
import type { JsonObject, LineageEventRecord } from "@kohaku-ui/spec-core";
import { hostErrorFromResponse } from "./errors.js";
import { type ComposeStreamEvent, readComposeStream, toComposeStreamEvent } from "./stream.js";
import { globalTransport, type Transport } from "./transport.js";
import type {
  AnalyticsSummaryView,
  CatalogResponse,
  ComponentDraft,
  ComposeRequest,
  ComposeView,
  FixationProposalView,
  FixationRecordView,
  NormalizeRequest,
  NormalizeResult,
  PromotionAction,
  PromotionCandidateView,
  PromotionPreviewView,
  PromotionReconcileSummaryView,
  SendEventRequest,
} from "./types.js";

/** Configuration for creating a typed host client. */
export interface KohakuClientConfig {
  /**
   * Base URL of the host (where the REST profile is mounted; e.g. "/api/kohaku" or "https://host/api/kohaku").
   * Trailing slashes are stripped. SPEC-conformant routes (/compose etc.) resolve under this prefix.
   */
  baseUrl: string;
  /**
   * Extra headers attached to every request (multi-tenant x-kohaku-tenant, trace ID, etc.).
   * A function, so it is evaluated per call (a tenant switch takes effect from the next request). Same style as
   * data-binding's BindingClientConfig.headers.
   */
  headers?: () => Record<string, string> | undefined;
  /**
   * Low-level transport (fetch dependency injection). Defaults to the global fetch when omitted. Tests inject
   * the in-memory Hono app's app.request. Note that the BindingClient returned by binding() uses data-binding's
   * default fetcher (this transport only applies to compose / events / stream / governance routes).
   */
  transport?: Transport;
}

/**
 * Request options common to every method (received as a trailing optional argument for backward compatibility).
 * signal is propagated to the transport's RequestInit.signal and used for per-request cancellation
 * (AbortController.abort() can abort an in-flight fetch).
 */
export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * Options for PromotionsClient.approve. acknowledgedSuggestion (additive, optional) is sent as the request
 * body's own field of the same name; the server records it on `component.schemaEdited` as `acknowledged`
 * (recorded, not enforced — see docs/design.md §9.2 and `@kohaku-ui/lineage`'s `ApproveOptions`).
 */
export interface PromotionApproveOptions extends RequestOptions {
  acknowledgedSuggestion?: boolean;
}

/** Query for GET /lineage (audit surface; all optional). */
export interface LineageQuery {
  /** Event type (e.g. ["view.composed"]). When set, only events matching any of them. */
  type?: string[];
  intentHash?: string;
  artifactId?: string;
  specHash?: string;
  /** ISO8601 timestamp. Narrows to events at or after this. */
  since?: string;
  /** ISO8601 timestamp. Narrows to events at or before this (ts <= until, inclusive; same interpretation as /analytics). */
  until?: string;
  /** Return limit (clamped to 1..1000 on the host side). */
  limit?: number;
}

/** A single POST /telemetry event (rendered / componentUsed). */
export type TelemetryEvent =
  | {
      kind: "rendered";
      specHash: string;
      surface?: string;
      renderer?: string;
      durationMs?: number;
    }
  | {
      kind: "componentUsed";
      artifactId: string;
      surface?: string;
      outcome?: "ok" | "error";
      sessionId?: string;
    };

/** Management surface for the promotion pipeline (L2→L1), typed. */
export interface PromotionsClient {
  /**
   * List candidates without side effects (GET /promotions). With `status`, narrows to that status via the
   * `?status=` query (read-only, no auto-nominate side effect — distinct from `evaluate`); omitted returns
   * every candidate.
   */
  list(opts?: RequestOptions & { status?: string }): Promise<PromotionCandidateView[]>;
  /** Auto-nominate candidates by usage-log threshold, then return the list (POST /promotions/evaluate; has side effects). */
  evaluate(opts?: RequestOptions): Promise<PromotionCandidateView[]>;
  /** Fetch a single candidate (GET /promotions/:id). Absent → throws NOT_FOUND. */
  get(artifactId: string, opts?: RequestOptions): Promise<PromotionCandidateView>;
  /**
   * Fetch preview material (POST /promotions/:id/preview). Returns the recorded artifact's html/sha256, and,
   * if a data reference was recorded, the ref + a read capability. Missing html or absent → throws NOT_FOUND.
   */
  preview(artifactId: string, opts?: RequestOptions): Promise<PromotionPreviewView>;
  /**
   * Approve and register (POST /promotions/:id/approve). draft is the wire shape including paramsJsonSchema /
   * queryTemplate. opts.acknowledgedSuggestion (additive, optional) records whether the reviewer ticked the
   * "I reviewed the suggestion" acknowledgement before approving — recorded on the server, not enforced.
   */
  approve(
    artifactId: string,
    draft: ComponentDraft,
    opts?: PromotionApproveOptions,
  ): Promise<PromotionCandidateView>;
  /** Reject (POST /promotions/:id/reject). */
  reject(artifactId: string, opts?: RequestOptions): Promise<PromotionCandidateView>;
  /** Withdraw / unpublish (POST /promotions/:id/withdraw). */
  withdraw(artifactId: string, reason?: string, opts?: RequestOptions): Promise<PromotionCandidateView>;
  /** An arbitrary single transition (POST /promotions/:id/actions). */
  act(artifactId: string, action: PromotionAction, opts?: RequestOptions): Promise<PromotionCandidateView>;
  /**
   * Force the projection recovery from snapshot authority on demand (POST /promotions/reconcile; an operator
   * escape hatch — the same recovery the host already runs at startup). Scans across every tenant (no per-tenant
   * scoping). 501 if the host's PromotionsApi does not implement `reconcile`.
   */
  reconcile(opts?: RequestOptions): Promise<PromotionReconcileSummaryView>;
}

/**
 * Management surface for fixation (L1→L0), typed.
 *
 * "Undoing a fixation" carries a different name at each layer of the stack (wire contract, so none of
 * these change):
 * - This client: `unfixate` (`remove` kept as a deprecated alias).
 * - REST route: `POST /fixations/:intentHash/remove`.
 * - Governance-hook operation kind: `fixation.remove`.
 * - `@kohaku-ui/lineage`'s `Fixations` service method: `unfixate`.
 * - `StoragePort` primitive: `deleteFixation`.
 * - Audit event: `intent.unfixated`.
 */
export interface FixationsClient {
  /** List fixated records (GET /fixations). */
  list(opts?: RequestOptions): Promise<FixationRecordView[]>;
  /** List fixation proposals (GET /fixations/proposals). */
  proposals(opts?: RequestOptions): Promise<FixationProposalView[]>;
  /** Fixate an Intent (POST /fixations/approve). Served via the L0 path from the next request on. */
  approve(
    intent: { canonical: string; params: JsonObject },
    opts?: RequestOptions,
  ): Promise<FixationRecordView>;
  /** Remove a fixation (POST /fixations/:intentHash/remove). See {@link FixationsClient}'s doc comment for the naming map across layers. */
  unfixate(intentHash: string, opts?: RequestOptions): Promise<void>;
  /** @deprecated Use {@link FixationsClient.unfixate} instead. Kept for backward compatibility; same request. */
  remove(intentHash: string, opts?: RequestOptions): Promise<void>;
}

/** Query for GET /analytics/summary (aggregation window; all optional — same fields as /lineage's window). */
export interface AnalyticsSummaryQuery {
  since?: string;
  until?: string;
  /** Return limit (clamped to 1..1000 on the host side; default 200). */
  limit?: number;
}

/** Read-only surface for the usage-analytics aggregate summary. */
export interface AnalyticsClient {
  /** Aggregated summary over the audit event window (GET /analytics/summary). */
  summary(query?: AnalyticsSummaryQuery, opts?: RequestOptions): Promise<AnalyticsSummaryView>;
}

/** Typed host client (typed wrapper over every route in REST profile §6.1). */
export interface KohakuClient {
  /** POST /compose (`{intent}` or `{input}` → `{spec, capability}`). */
  compose(req: ComposeRequest, opts?: RequestOptions): Promise<ComposeView>;
  /** POST /intent/normalize (`{input}` → `{intent, source}`). */
  normalizeIntent(req: NormalizeRequest, opts?: RequestOptions): Promise<NormalizeResult>;
  /** POST /events (component event → Intent delta → recompose). */
  sendEvent(req: SendEventRequest, opts?: RequestOptions): Promise<ComposeView>;
  /**
   * Typed consumption of POST /compose/stream (SSE; SPEC §6.1.1 [Draft]). Yields spec → patch → done | error
   * as typed events. A malformed body before the stream starts (400 etc.) is thrown as KohakuHostError, while a
   * generation failure after it starts terminates with an in-band `{kind:"error"}` event (REST-STR-003).
   * opts.signal is propagated to fetch, so aborting mid-receive cancels the whole stream.
   */
  composeStream(req: ComposeRequest, opts?: RequestOptions): AsyncGenerator<ComposeStreamEvent, void>;
  /**
   * Returns a fetch thunk for POST /compose/stream (for passing to renderer-react's useSpecStream).
   * Making the transport lazy lets the hook open a fresh stream on every start.
   */
  composeStreamRequest(req: ComposeRequest, opts?: RequestOptions): () => Promise<Response>;
  /** GET /catalog (serialized list of ComponentDefinition + catalogVersion). */
  catalog(opts?: RequestOptions): Promise<CatalogResponse>;
  /** GET /lineage (event sequence for the audit surface). */
  lineage(query?: LineageQuery, opts?: RequestOptions): Promise<LineageEventRecord[]>;
  /** POST /telemetry (batch ingest of rendered / component.used). */
  telemetry(events: TelemetryEvent[], opts?: RequestOptions): Promise<void>;
  /** Management surface for the promotion pipeline (L2→L1). */
  promotions: PromotionsClient;
  /** Management surface for fixation (L1→L0). */
  fixations: FixationsClient;
  /** Read-only surface for the usage-analytics aggregate summary. */
  analytics: AnalyticsClient;
  /**
   * Composes a client for reference-passing data binding (GET /binding/resolve, POST /binding/action).
   * baseUrl and headers are inherited from the SDK config. Pass the capability obtained from the /compose response.
   * The implementation is data-binding's createBindingClient (no duplicate implementation). To swap the fetcher,
   * use createBindingClient directly (also re-exported from client).
   */
  binding(config?: Pick<BindingClientConfig, "capability" | "fetcher" | "actionFetcher">): BindingClient;
  /**
   * Low-level fetch escape hatch (routes outside SPEC scope — e.g. the sample's /api/health).
   * The headers hook and transport are applied, but the response is not JSON-parsed or error-converted (returns the raw Response).
   * Input starting with `/` or `http(s):` is used as-is; otherwise it is resolved by prefixing baseUrl.
   */
  request(input: string, init?: RequestInit): Promise<Response>;
}

/** Creates a typed host client. */
export function createKohakuClient(config: KohakuClientConfig): KohakuClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const transport = config.transport ?? globalTransport();
  const extraHeaders = (): Record<string, string> => config.headers?.() ?? {};

  /** Merges the headers hook into init (evaluated per call). */
  const withHeaders = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...extraHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });

  /** Inspects the response; throws KohakuHostError when !ok, otherwise returns the JSON as T. */
  const parse = async <T>(res: Response): Promise<T> => {
    const body = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw hostErrorFromResponse(res.status, body);
    return body as T;
  };

  /** Maps opts.signal onto RequestInit (per-request cancellation; leaves init unchanged when unset). */
  const withSignal = (init: RequestInit, opts?: RequestOptions): RequestInit =>
    opts?.signal != null ? { ...init, signal: opts.signal } : init;

  /** JSON POST (no body when body is omitted). */
  const post = async <T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> => {
    const init: RequestInit =
      body !== undefined
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : { method: "POST" };
    return parse<T>(await transport(`${baseUrl}${path}`, withHeaders(withSignal(init, opts))));
  };

  const get = async <T>(path: string, opts?: RequestOptions): Promise<T> =>
    parse<T>(await transport(`${baseUrl}${path}`, withHeaders(withSignal({}, opts))));

  const composeBody = (req: ComposeRequest): Record<string, unknown> => ({
    ...(req.intent != null ? { intent: req.intent } : {}),
    ...(req.input != null ? { input: req.input } : {}),
    ...(req.session != null ? { session: req.session } : {}),
  });

  const streamRequest = (req: ComposeRequest, opts?: RequestOptions): (() => Promise<Response>) => {
    return () =>
      transport(
        `${baseUrl}/compose/stream`,
        withHeaders(
          withSignal(
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(composeBody(req)),
            },
            opts,
          ),
        ),
      );
  };

  const promotions: PromotionsClient = {
    async list(opts) {
      const qs =
        opts?.status != null && opts.status !== "" ? `?status=${encodeURIComponent(opts.status)}` : "";
      return (await get<{ candidates: PromotionCandidateView[] }>(`/promotions${qs}`, opts)).candidates ?? [];
    },
    async evaluate(opts) {
      return (
        (await post<{ candidates: PromotionCandidateView[] }>("/promotions/evaluate", undefined, opts))
          .candidates ?? []
      );
    },
    async get(artifactId, opts) {
      return (
        await get<{ candidate: PromotionCandidateView }>(
          `/promotions/${encodeURIComponent(artifactId)}`,
          opts,
        )
      ).candidate;
    },
    async preview(artifactId, opts) {
      return (
        await post<{ preview: PromotionPreviewView }>(
          `/promotions/${encodeURIComponent(artifactId)}/preview`,
          undefined,
          opts,
        )
      ).preview;
    },
    async approve(artifactId, draft, opts) {
      return (
        await post<{ candidate: PromotionCandidateView }>(
          `/promotions/${encodeURIComponent(artifactId)}/approve`,
          {
            draft,
            ...(opts?.acknowledgedSuggestion != null
              ? { acknowledgedSuggestion: opts.acknowledgedSuggestion }
              : {}),
          },
          opts,
        )
      ).candidate;
    },
    async reject(artifactId, opts) {
      return (
        await post<{ candidate: PromotionCandidateView }>(
          `/promotions/${encodeURIComponent(artifactId)}/reject`,
          undefined,
          opts,
        )
      ).candidate;
    },
    async withdraw(artifactId, reason, opts) {
      return (
        await post<{ candidate: PromotionCandidateView }>(
          `/promotions/${encodeURIComponent(artifactId)}/withdraw`,
          reason != null ? { reason } : {},
          opts,
        )
      ).candidate;
    },
    async act(artifactId, action, opts) {
      return (
        await post<{ candidate: PromotionCandidateView }>(
          `/promotions/${encodeURIComponent(artifactId)}/actions`,
          { action },
          opts,
        )
      ).candidate;
    },
    async reconcile(opts) {
      return (
        await post<{ summary: PromotionReconcileSummaryView }>("/promotions/reconcile", undefined, opts)
      ).summary;
    },
  };

  const fixations: FixationsClient = {
    async list(opts) {
      return (await get<{ fixations: FixationRecordView[] }>("/fixations", opts)).fixations ?? [];
    },
    async proposals(opts) {
      return (await get<{ proposals: FixationProposalView[] }>("/fixations/proposals", opts)).proposals ?? [];
    },
    async approve(intent, opts) {
      return (await post<{ fixation: FixationRecordView }>("/fixations/approve", { intent }, opts)).fixation;
    },
    async unfixate(intentHash, opts) {
      await post<{ ok: true }>(`/fixations/${encodeURIComponent(intentHash)}/remove`, undefined, opts);
    },
    async remove(intentHash, opts) {
      return fixations.unfixate(intentHash, opts);
    },
  };

  const analytics: AnalyticsClient = {
    async summary(query = {}, opts) {
      const params = new URLSearchParams();
      if (query.since != null) params.set("since", query.since);
      if (query.until != null) params.set("until", query.until);
      if (query.limit != null) params.set("limit", String(query.limit));
      const qs = params.toString();
      return get<AnalyticsSummaryView>(`/analytics/summary${qs !== "" ? `?${qs}` : ""}`, opts);
    },
  };

  return {
    async compose(req, opts) {
      return post<ComposeView>("/compose", composeBody(req), opts);
    },
    async normalizeIntent(req, opts) {
      return post<NormalizeResult>(
        "/intent/normalize",
        {
          input: req.input,
          ...(req.session != null ? { session: req.session } : {}),
        },
        opts,
      );
    },
    async sendEvent(req, opts) {
      return post<ComposeView>(
        "/events",
        {
          intent: req.intent,
          event: { on: req.on, payload: req.payload },
          ...(req.session != null ? { session: req.session } : {}),
        },
        opts,
      );
    },
    async *composeStream(req, opts) {
      const res = await streamRequest(req, opts)();
      if (!res.ok) {
        // A failure before the stream starts (malformed body 400 / invalid Intent 422 etc.) is thrown as a normal envelope.
        throw hostErrorFromResponse(res.status, await res.json().catch(() => null));
      }
      if (res.body == null) {
        throw hostErrorFromResponse(res.status, { error: { code: "INTERNAL", message: "No SSE body" } });
      }
      for await (const wire of readComposeStream(res.body)) {
        const ev = toComposeStreamEvent(wire);
        yield ev;
        if (ev.kind === "done" || ev.kind === "error") return;
      }
      // The body ended (EOF) without a done or error event — a disconnected/truncated stream, not a
      // successful completion (REST-STR-003 requires exactly one of done|error). Without this, the
      // generator would just return normally here, silently treating the interruption as success.
      throw hostErrorFromResponse(res.status, {
        error: { code: "INTERNAL", message: "Compose stream ended before a done or error event" },
      });
    },
    composeStreamRequest(req, opts) {
      return streamRequest(req, opts);
    },
    async catalog(opts) {
      return get<CatalogResponse>("/catalog", opts);
    },
    async lineage(query = {}, opts) {
      const params = new URLSearchParams();
      const types = (query.type ?? []).filter((t) => t.length > 0);
      if (types.length > 0) params.set("type", types.join(","));
      if (query.intentHash != null) params.set("intentHash", query.intentHash);
      if (query.artifactId != null) params.set("artifactId", query.artifactId);
      if (query.specHash != null) params.set("specHash", query.specHash);
      if (query.since != null) params.set("since", query.since);
      if (query.until != null) params.set("until", query.until);
      if (query.limit != null) params.set("limit", String(query.limit));
      const qs = params.toString();
      return (
        (await get<{ events: LineageEventRecord[] }>(`/lineage${qs !== "" ? `?${qs}` : ""}`, opts)).events ??
        []
      );
    },
    async telemetry(events, opts) {
      await post<{ ok: true }>("/telemetry", { events }, opts);
    },
    promotions,
    fixations,
    analytics,
    binding(bindingConfig = {}) {
      return createBindingClient({
        baseUrl,
        headers: config.headers,
        ...bindingConfig,
      });
    },
    request(input, init) {
      const url = input.startsWith("/") || /^https?:/i.test(input) ? input : `${baseUrl}${input}`;
      return transport(url, withHeaders(init));
    },
  };
}
