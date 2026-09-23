import {
  type ComposeRequest,
  type ComposeView,
  createKohakuClient,
  type NormalizeResult,
} from "@kohaku-ui/client";
import type { JsonObject } from "@kohaku-ui/spec-core";
import { getLang } from "../i18n/lang.js";
import { roleHeader } from "./role.js";
import { tenantHeader } from "./tenant.js";

export type { ComposeView, NormalizeResult };

/**
 * Singleton of the typed host client SDK (@kohaku-ui/client). Hand-written fetch to the REST host is abolished and
 * unified through the SDK. The selected tenant (x-kohaku-tenant) and selected role (x-kohaku-role; declarative RBAC)
 * are automatically attached to every request by the headers hook. The selected UI language rides
 * `session.locale` on every compose/normalize/events body (the server varies NL hints and generation output language,
 * cache-separated per language). Below are thin wrappers that adapt to sample-specific call shapes.
 */
// Exported for AdminPage, which hands it to @kohaku-ui/admin-react's KohakuAdmin (the package's tabs call
// client.promotions / client.fixations / client.analytics directly; it never reads a module-level singleton).
export const client = createKohakuClient({
  baseUrl: "/api/kohaku",
  headers: () => ({ ...tenantHeader(), ...roleHeader() }),
});

/**
 * Low-level fetch for routes outside SPEC (sample-specific /api/health, /api/admin/bump-data-version).
 * Delegates to the SDK's escape hatch (client.request) — the SDK is responsible for attaching the tenant header.
 */
export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return client.request(path, init);
}

/** Composition from a GUI operation (deterministic path, does not pass through the LLM) */
export function composeGui(args: {
  intent: string;
  params: JsonObject;
  surface?: string;
  sessionId?: string;
}): Promise<ComposeView> {
  return client.compose({
    input: {
      kind: "gui",
      action: "view.select",
      params: { intent: args.intent, ...args.params },
    },
    session: {
      surface: args.surface ?? "web",
      ...(args.sessionId != null ? { sessionId: args.sessionId } : {}),
      locale: getLang(),
    },
  });
}

/** Normalization only, from natural language (for displaying the normalization chip in chat) */
export function normalizeNl(text: string, sessionId?: string): Promise<NormalizeResult> {
  return client.normalizeIntent({
    // locale rides both the NL input (NLQuery.locale, the per-input hint) and the session (belt and braces).
    input: { kind: "nl", text, locale: getLang() },
    session: { surface: "chat", ...(sessionId != null ? { sessionId } : {}), locale: getLang() },
  });
}

/**
 * Returns a fetch to streaming composition (POST /compose/stream). Passed to useSpecStream's request DI.
 * By making the transport (fetch) lazily executed, the hook can open a new stream on every start.
 * The body is identical to /compose (`{intent}` or `{input}` + session?). The current UI language is
 * merged into session.locale here so call sites stay unchanged.
 */
export function composeStreamRequest(body: ComposeRequest): () => Promise<Response> {
  return client.composeStreamRequest({
    ...body,
    session: { surface: "web", ...body.session, locale: getLang() },
  });
}

/** Part event (interaction loop) */
export function sendEvent(args: {
  intent: { canonical: string; params: JsonObject };
  on: string;
  payload: JsonObject;
  surface?: string;
  sessionId?: string;
}): Promise<ComposeView> {
  return client.sendEvent({
    intent: args.intent,
    on: args.on,
    payload: args.payload,
    session: {
      surface: args.surface ?? "web",
      ...(args.sessionId != null ? { sessionId: args.sessionId } : {}),
      locale: getLang(),
    },
  });
}

/** Response shape of /api/health (kept in sync with app.ts's app.get("/api/health")) */
export interface HealthResponse {
  ok: boolean;
  llm: { provider: string; model: string };
  seed: { records: number; dataVersion: string };
  catalogVersion: string;
  intents: string[];
  promoted: string[];
}

export async function fetchHealth(): Promise<HealthResponse> {
  // /health is outside the SDK (sample-specific). Fetch it via the escape hatch and inspect the status.
  const res = await apiFetch("/api/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as HealthResponse;
}

export async function bumpDataVersion(): Promise<string> {
  const res = await apiFetch("/api/admin/bump-data-version", { method: "POST" });
  const json = (await res.json()) as { dataVersion: string };
  return json.dataVersion;
}
