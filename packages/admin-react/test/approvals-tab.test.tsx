import { actionPayloadHash } from "@kohaku-ui/spec-core";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApprovalsTab, defaultAdminMessages as m } from "../src/index.js";
import { jsonResponse, renderInAdmin } from "./helpers.js";

const REQUEST_TS = new Date(Date.now() - 90_000).toISOString();

function requestedEvent(over: Record<string, unknown> = {}, actorId: string | null = "demo-viewer") {
  return {
    id: "ev-1",
    ts: REQUEST_TS,
    type: "action.approvalRequested",
    actor: actorId != null ? { kind: "user", id: actorId } : { kind: "user" },
    payload: {
      action: "sales.refund",
      payloadHash: "sha256:0123456789abcdef0123",
      tier: "approve",
      requestId: "req-1",
      ...over,
    },
  };
}

const lineage = (events: unknown[]) => () => jsonResponse({ events });

describe("ApprovalsTab", () => {
  it("renders a pending row from the lineage tail and asks lineage only for the approval event types", async () => {
    const view = renderInAdmin(<ApprovalsTab />, {
      handlers: { "GET /lineage": lineage([requestedEvent(), requestedEvent({ requestId: "req-2" })]) },
    });
    await screen.findByText("sales.refund");
    expect(screen.getByText("demo-viewer")).toBeTruthy();
    expect(view.container.textContent).toContain(m.approvals.requestCount(2));
    expect(view.container.textContent).toContain("req-1, req-2");
    expect(view.container.textContent).toContain("1m ago");
    const hash = screen.getByText("sha256:01234");
    expect(hash.getAttribute("title")).toBe("sha256:0123456789abcdef0123");
    const lineageCall = view.calls.find((c) => c.url.includes("/lineage"))!;
    const params = new URL(lineageCall.url, "http://x").searchParams;
    expect(params.get("type")).toBe("action.approvalRequested,action.invoked,action.approved");
    expect(params.get("limit")).toBe("1000");
    expect(Date.parse(params.get("since")!)).toBeLessThan(Date.now() - 23 * 3600_000);
  });

  it("shows the empty state", async () => {
    renderInAdmin(<ApprovalsTab />, { handlers: { "GET /lineage": lineage([]) } });
    await screen.findByText(m.approvals.empty);
  });

  it("drops a request that was approved afterwards", async () => {
    renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": lineage([
          requestedEvent(),
          {
            id: "ev-2",
            ts: new Date(Date.now() - 30_000).toISOString(),
            type: "action.approved",
            actor: { kind: "user", id: "demo-viewer" },
            payload: {
              action: "sales.refund",
              payloadHash: "sha256:0123456789abcdef0123",
              approverId: "demo-approver",
              requesterId: "demo-viewer",
            },
          },
        ]),
      },
    });
    await screen.findByText(m.approvals.empty);
  });

  it("approves with {action, payloadHash, requesterId} and shows the token with its TTL", async () => {
    let body: unknown = null;
    const view = renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": lineage([requestedEvent()]),
        "POST /approvals": (call) => {
          body = JSON.parse(call.init!.body as string);
          return jsonResponse({ approval: "tok.en.value" });
        },
      },
    });
    await screen.findByText("sales.refund");
    fireEvent.click(screen.getByText(m.approvals.approveButton));
    const input = (await screen.findByLabelText(m.approvals.tokenLabel)) as HTMLInputElement;
    expect(input.value).toBe("tok.en.value");
    expect(input.readOnly).toBe(true);
    expect(body).toEqual({
      action: "sales.refund",
      payloadHash: "sha256:0123456789abcdef0123",
      requesterId: "demo-viewer",
    });
    expect(view.notices).toEqual([{ text: m.approvals.issuedNotice("sales.refund"), kind: "info" }]);
    expect(view.container.textContent).toContain(m.approvals.issuedAge(0, 300));
    expect(screen.queryByText(m.approvals.reissue)).toBeNull();
  });

  it("copies the token to the clipboard", async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written.push(text);
        },
      },
    });
    try {
      renderInAdmin(<ApprovalsTab />, {
        handlers: {
          "GET /lineage": lineage([requestedEvent()]),
          "POST /approvals": () => jsonResponse({ approval: "tok.en.value" }),
        },
      });
      await screen.findByText("sales.refund");
      fireEvent.click(screen.getByText(m.approvals.approveButton));
      await screen.findByLabelText(m.approvals.tokenLabel);
      fireEvent.click(screen.getByText(m.approvals.copyButton));
      await screen.findByText(m.approvals.copied);
      expect(written).toEqual(["tok.en.value"]);
    } finally {
      Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: undefined });
    }
  });

  it("explains a denied approver (403)", async () => {
    const view = renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": lineage([requestedEvent()]),
        "POST /approvals": () => jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
      },
    });
    await screen.findByText("sales.refund");
    fireEvent.click(screen.getByText(m.approvals.approveButton));
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toEqual({
      text: m.deniedMessage("CAPABILITY_DENIED", m.approvals.opIssue),
      kind: "error",
    });
    expect(screen.queryByLabelText(m.approvals.tokenLabel)).toBeNull();
  });

  it("explains a self-approval (400)", async () => {
    const view = renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": lineage([requestedEvent()]),
        "POST /approvals": () => jsonResponse({ error: { code: "BAD_REQUEST", message: "self" } }, 400),
      },
    });
    await screen.findByText("sales.refund");
    fireEvent.click(screen.getByText(m.approvals.approveButton));
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toEqual({ text: m.approvals.selfApproval, kind: "error" });
  });

  it("explains a host with no approvals wired (501)", async () => {
    const view = renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": lineage([requestedEvent()]),
        "POST /approvals": () => jsonResponse({ error: { code: "NOT_IMPLEMENTED", message: "nope" } }, 501),
      },
    });
    await screen.findByText("sales.refund");
    fireEvent.click(screen.getByText(m.approvals.approveButton));
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toEqual({ text: m.approvals.notConfigured, kind: "error" });
  });

  it("falls back to the generic failure text for any other error", async () => {
    const view = renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": lineage([requestedEvent()]),
        "POST /approvals": () => jsonResponse({ error: { code: "INTERNAL", message: "boom" } }, 500),
      },
    });
    await screen.findByText("sales.refund");
    fireEvent.click(screen.getByText(m.approvals.approveButton));
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toEqual({ text: m.approvals.issueFailed, kind: "error" });
  });

  it("disables Approve for a row with no recorded requester", async () => {
    renderInAdmin(<ApprovalsTab />, {
      handlers: { "GET /lineage": lineage([requestedEvent({}, null)]) },
    });
    await screen.findByText("sales.refund");
    const button = screen.getByText(m.approvals.approveButton) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(m.approvals.requesterUnknown);
  });

  it("shows a recorded payload and warns when it does not match the hash", async () => {
    const payload = { orderId: "o-1", amount: 10 };
    const hash = await actionPayloadHash(payload);
    renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": lineage([
          requestedEvent({ payloadHash: hash, payload }),
          requestedEvent({ action: "sales.void", payloadHash: "sha256:bad", payload }, "demo-other"),
        ]),
      },
    });
    await screen.findByText("sales.refund");
    expect(screen.getAllByText(m.approvals.payloadLabel)).toHaveLength(2);
    expect(document.body.textContent).toContain('"orderId": "o-1"');
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText(m.approvals.payloadMismatch)).toBeTruthy();
  });

  it("explains a denied lineage read", async () => {
    const view = renderInAdmin(<ApprovalsTab />, {
      handlers: {
        "GET /lineage": () => jsonResponse({ error: { code: "CAPABILITY_DENIED", message: "no" } }, 403),
      },
    });
    await waitFor(() => expect(view.notices).toHaveLength(1));
    expect(view.notices[0]).toEqual({
      text: m.deniedMessage("CAPABILITY_DENIED", m.approvals.opRead),
      kind: "error",
    });
  });
});
