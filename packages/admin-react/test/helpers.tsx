import { createKohakuClient, type KohakuClient } from "@kohaku-ui/client";
import { type RenderResult, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AdminProvider, type AdminProviderProps } from "../src/index.js";

export type FetchCall = { url: string; init?: RequestInit };
export type Handler = (call: FetchCall) => Response;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A typed client whose transport is an in-memory table keyed by "METHOD path-suffix" (the same style as the
 * sample's pre-extraction characterization test). Every tab's reload also fires GET /analytics/summary for the
 * "N or more uses" thresholds, so that route has a default unless a test overrides it.
 */
export function stubClient(handlers: Record<string, Handler>): { client: KohakuClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const table: Record<string, Handler> = {
    "GET /analytics/summary": () =>
      jsonResponse({ promotionPolicy: { fixationMinUses: 3, promotionMinUses: 2 } }),
    ...handlers,
  };
  const client = createKohakuClient({
    baseUrl: "/api/kohaku",
    transport: async (url, init) => {
      const call = { url, init };
      calls.push(call);
      const method = init?.method ?? "GET";
      const key = Object.keys(table).find(
        (k) => k.startsWith(`${method} `) && url.split("?")[0]!.endsWith(k.slice(method.length + 1)),
      );
      if (key == null) throw new Error(`unhandled fetch: ${method} ${url}`);
      return table[key]!(call);
    },
  });
  return { client, calls };
}

export type Notice = { text: string; kind?: "info" | "error" };

/** Renders `ui` inside AdminProvider with a stub client and records notices. */
export function renderInAdmin(
  ui: ReactNode,
  opts: { handlers?: Record<string, Handler> } & Partial<
    Omit<AdminProviderProps, "children" | "client" | "onNotice">
  > = {},
): RenderResult & { calls: FetchCall[]; notices: Notice[]; client: KohakuClient } {
  const { handlers = {}, ...provider } = opts;
  const { client, calls } = stubClient(handlers);
  const notices: Notice[] = [];
  const result = render(
    <AdminProvider client={client} onNotice={(text, kind) => notices.push({ text, kind })} {...provider}>
      {ui}
    </AdminProvider>,
  );
  return Object.assign(result, { calls, notices, client });
}
