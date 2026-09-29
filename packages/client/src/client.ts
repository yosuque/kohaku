import { type BindingClient, type BindingClientConfig, createBindingClient } from "@kohaku-ui/data-binding";
import type { JsonObject, LineageEventRecord, UISpec } from "@kohaku-ui/spec-core";
import { hostErrorFromResponse } from "./errors.js";
import { buildExplainReport, type ExplainReport } from "./explain.js";
import { type ComposeStreamEvent, readComposeStream, toComposeStreamEvent } from "./stream.js";
import { globalTransport, type Transport } from "./transport.js";
import type {
  AnalyticsSummaryView,
  ApprovalIssueRequest,
  ApprovalIssueResult,
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
  /**
   * Called after every response this client receives (success or failure alike; not called for the
   * `binding()` sub-client, which has its own fetcher). `requestId` is the response's `X-Request-Id` header
   * (host-rest stamps one on every response) -- undefined when the header is absent, e.g. a non-conformant
   * host or a test double transport that does not set it. Exists so a devtool (admin-react's DevTools, via
   * `withDevToolsCapture`) can passively collect recent requestIds without wrapping every call site by hand;
   * a caller uninterested in this can simply omit it (no behavior change).
   *
   * Browser callers: reading `X-Request-Id` cross-origin requires the host to send
   * `Access-Control-Expose-Headers: X-Request-Id` (a plain same-origin CORS response header list does not
   * expose custom headers to `fetch`'s `Response.headers` by default) -- see docs/user-guide.md's DevTools
   * section.
   */
  onResponse?: (info: { path: string; status: number; requestId?: string }) => void;
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
  /** Filter by the `correlationId` payload field (exact equality; design.md #53). */
  correlationId?: string;
  /** ISO8601 timestamp. Narrows to events at or after this. */
  since?: string;
  /** ISO8601 timestamp. Narrows to events at or before this (ts <= until, inclusive; same interpretation as /analytics). */
  until?: string;
  /** Return limit (clamped to 1..1000 on the host side). */
  limit?: number;
}

/**
 * Query for the GET /lineage?order=asc forward-paging iterator (`KohakuClient.lineagePages`, design.md
 * #53). Every `LineageQuery` field applies except `limit` (`pageSize` takes its place).
 */
export interface LineagePageQuery extends Omit<LineageQuery, "limit"> {
  /** Requested page size (clamped to 1..1000 on the host side; the host's own default applies when omitted). */
  pageSize?: number;
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

/** Approver-side surface for `"approve"`-tier governed Actions (SPEC ACT-APR-001 [Draft]), typed. */
export interface ApprovalsClient {
  /**
   * Mints an approval token bound to `(action, payloadHash, requesterId, tenant)` (POST /approvals). The
   * caller is the approver: their own principal id becomes `approverId`, so a self-approval is refused (400
   * `BAD_REQUEST`). Also throws 403 `CAPABILITY_DENIED` when the host's `authorizeGovernance` does not
   * authorize this approver for `req.action`, and 501 `NOT_IMPLEMENTED` on a host with no `ApprovalPort` or
   * no `authorizeGovernance` hook. Recompute `actionPayloadHash` from the payload shown to the approver before
   * calling (the descriptor's `payloadHash` alone is not something an approver can read).
   */
  issue(req: ApprovalIssueRequest, opts?: RequestOptions): Promise<ApprovalIssueResult>;
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
  /**
   * Walks the whole lineage log exhaustively via GET /lineage?order=asc (design.md #53), yielding one
   * page's events per iteration (a page may be short or empty) until the host reports no further page
   * (`nextCursor` absent) -- unlike
   * `lineage()` (a tail window bounded by `limit`), this covers every matching event, in append order.
   * Requires the host's storage to implement `StoragePort.pageLineage`; an unsupported backend rejects the
   * first page with a `KohakuHostError` (501 `NOT_IMPLEMENTED`).
   */
  lineagePages(query?: LineagePageQuery, opts?: RequestOptions): AsyncGenerator<LineageEventRecord[], void>;
  /** POST /telemetry (batch ingest of rendered / component.used). */
  telemetry(events: TelemetryEvent[], opts?: RequestOptions): Promise<void>;
  /**
   * `kohaku explain <requestId>`'s data source: gathers every lineage event recorded under `requestId`'s
   * correlationId (via `lineagePages({correlationId: requestId})`, so it is exhaustive, not limit-bounded)
   * and builds an {@link ExplainReport} from them (see {@link buildExplainReport}, the pure function this
   * wraps -- callers that already have the events in hand, e.g. from a cached page, can call it directly
   * instead). `opts.spec`, when passed, additionally populates the report's `scopes` field.
   *
   * A caller-supplied `X-Request-Id` is not guaranteed globally unique (see ExplainReport.composes's doc
   * comment), so this can return more than one compose's worth of data for a reused id.
   */
  explain(requestId: string, opts?: RequestOptions & { spec?: UISpec }): Promise<ExplainReport>;
  /** Management surface for the promotion pipeline (L2→L1). */
  promotions: PromotionsClient;
  /** Management surface for fixation (L1→L0). */
  fixations: FixationsClient;
  /** Read-only surface for the usage-analytics aggregate summary. */
  analytics: AnalyticsClient;
  /** Approver-side surface for `"approve"`-tier governed Actions (POST /approvals). */
  approvals: ApprovalsClient;
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

  /** The response's X-Request-Id header, or undefined when absent (see ComposeView.requestId's doc comment). */
  const requestIdOf = (res: Response): string | undefined => res.headers.get("X-Request-Id") ?? undefined;

  /**
   * Runs the transport and reports the response to config.onResponse (success or failure alike), before the
   * caller inspects/parses it. Every request path below (post / get / streamRequest / request) goes through
   * this single choke point so onResponse observes everything uniformly.
   */
  const callTransport = async (path: string, url: string, init: RequestInit): Promise<Response> => {
    const res = await transport(url, init);
    config.onResponse?.({ path, status: res.status, requestId: requestIdOf(res) });
    return res;
  };

  /** JSON POST (no body when body is omitted). */
  const post = async <T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> => {
    const init: RequestInit =
      body !== undefined
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : { method: "POST" };
    return parse<T>(await callTransport(path, `${baseUrl}${path}`, withHeaders(withSignal(init, opts))));
  };

  const get = async <T>(path: string, opts?: RequestOptions): Promise<T> =>
    parse<T>(await callTransport(path, `${baseUrl}${path}`, withHeaders(withSignal({}, opts))));

  const composeBody = (req: ComposeRequest): Record<string, unknown> => ({
    ...(req.intent != null ? { intent: req.intent } : {}),
    ...(req.input != null ? { input: req.input } : {}),
    ...(req.session != null ? { session: req.session } : {}),
  });

  const streamRequest = (req: ComposeRequest, opts?: RequestOptions): (() => Promise<Response>) => {
    return () =>
      callTransport(
        "/compose/stream",
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

  const approvals: ApprovalsClient = {
    async issue(req, opts) {
      return post<ApprovalIssueResult>(
        "/approvals",
        {
          action: req.action,
          payloadHash: req.payloadHash,
          requesterId: req.requesterId,
          ...(req.ttlSeconds != null ? { ttlSeconds: req.ttlSeconds } : {}),
        },
        opts,
      );
    },
  };

  /** POST that additionally stamps the response's X-Request-Id onto the parsed ComposeView (compose / sendEvent share this). */
  const postCompose = async (path: string, body: unknown, opts?: RequestOptions): Promise<ComposeView> => {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    const res = await callTransport(path, `${baseUrl}${path}`, withHeaders(withSignal(init, opts)));
    const view = await parse<ComposeView>(res);
    const requestId = requestIdOf(res);
    return requestId != null ? { ...view, requestId } : view;
  };

  const client: KohakuClient = {
    async compose(req, opts) {
      return postCompose("/compose", composeBody(req), opts);
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
      return postCompose(
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
        if (ev.kind === "done") {
          // The X-Request-Id header applies to the whole response (there is no per-frame id on the wire), so
          // it is stamped here rather than inside toComposeStreamEvent (which has no access to `res`).
          const requestId = requestIdOf(res);
          yield requestId != null ? { ...ev, requestId } : ev;
          return;
        }
        yield ev;
        if (ev.kind === "error") return;
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
      if (query.correlationId != null) params.set("correlationId", query.correlationId);
      if (query.since != null) params.set("since", query.since);
      if (query.until != null) params.set("until", query.until);
      if (query.limit != null) params.set("limit", String(query.limit));
      const qs = params.toString();
      return (
        (await get<{ events: LineageEventRecord[] }>(`/lineage${qs !== "" ? `?${qs}` : ""}`, opts)).events ??
        []
      );
    },
    async *lineagePages(query = {}, opts) {
      let cursor: string | undefined;
      for (;;) {
        const params = new URLSearchParams();
        params.set("order", "asc");
        const types = (query.type ?? []).filter((t) => t.length > 0);
        if (types.length > 0) params.set("type", types.join(","));
        if (query.intentHash != null) params.set("intentHash", query.intentHash);
        if (query.artifactId != null) params.set("artifactId", query.artifactId);
        if (query.specHash != null) params.set("specHash", query.specHash);
        if (query.correlationId != null) params.set("correlationId", query.correlationId);
        if (query.since != null) params.set("since", query.since);
        if (query.until != null) params.set("until", query.until);
        if (query.pageSize != null) params.set("pageSize", String(query.pageSize));
        if (cursor != null) params.set("cursor", cursor);
        const page = await get<{ events: LineageEventRecord[]; nextCursor?: string }>(
          `/lineage?${params.toString()}`,
          opts,
        );
        yield page.events ?? [];
        if (page.nextCursor == null) return;
        if (page.nextCursor === cursor) {
          throw new Error(
            "GET /lineage returned the same nextCursor it was given; refusing to page forever (a host must advance the cursor)",
          );
        }
        cursor = page.nextCursor;
      }
    },
    async telemetry(events, opts) {
      await post<{ ok: true }>("/telemetry", { events }, opts);
    },
    async explain(requestId, opts) {
      const events: LineageEventRecord[] = [];
      for await (const page of client.lineagePages({ correlationId: requestId }, opts)) {
        events.push(...page);
      }
      return buildExplainReport(events, opts?.spec);
    },
    promotions,
    fixations,
    analytics,
    approvals,
    binding(bindingConfig = {}) {
      return createBindingClient({
        baseUrl,
        headers: config.headers,
        ...bindingConfig,
      });
    },
    request(input, init) {
      const url = input.startsWith("/") || /^https?:/i.test(input) ? input : `${baseUrl}${input}`;
      return callTransport(input, url, withHeaders(init));
    },
  };
  return client;
}
