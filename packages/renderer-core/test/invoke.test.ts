import { type BindingClient, BindingError } from "@kohaku-ui/data-binding";
import type { ComponentNode, JsonObject, UISpec } from "@kohaku-ui/spec-core";
import { describe, expect, it, vi } from "vitest";
import {
  type ActionManifest,
  type ActionPhase,
  actionPhaseNotice,
  DEFAULT_MESSAGES,
  NOOP_INVALIDATION_BUS,
  preflightAction,
  resolveActionName,
  resolveInvokeTarget,
  runInvokeTarget,
  shortPayloadHash,
  shouldPromptForApproval,
  summarizeActionForModel,
} from "../src/index.js";

type EventDecl = { on: string; emit: string; payload: Record<string, unknown> };

function makeSpec(events: EventDecl[]): UISpec {
  return { events } as unknown as UISpec;
}
function makeNode(id: string, props: Record<string, unknown> = {}): ComponentNode {
  return { id, type: "actionButton", props } as unknown as ComponentNode;
}

describe("resolveInvokeTarget (deciding direct execution of action.invoke)", () => {
  it("forward when the declaration is not action.invoke", () => {
    const spec = makeSpec([{ on: "b.click", emit: "intent.patch", payload: {} }]);
    expect(
      resolveInvokeTarget(spec, makeNode("b", { action: "x" }), "click", {}, { hasBinding: true }),
    ).toEqual({
      kind: "forward",
    });
  });

  it("forward when binding is unset (hasBinding=false)", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: {} }]);
    expect(
      resolveInvokeTarget(spec, makeNode("b", { action: "x" }), "click", {}, { hasBinding: false }),
    ).toEqual({
      kind: "forward",
    });
  });

  it("forward when the action name cannot be determined", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: {} }]);
    expect(resolveInvokeTarget(spec, makeNode("b"), "click", {}, { hasBinding: true })).toEqual({
      kind: "forward",
    });
  });

  it("returns an invoke with props.action and a resolved payload", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: { id: "$row.id" } }]);
    const r = resolveInvokeTarget(
      spec,
      makeNode("b", { action: "archive" }),
      "click",
      { row: { id: 9 } },
      { hasBinding: true },
    );
    expect(r).toEqual({ kind: "invoke", action: "archive", payload: { id: 9 } });
  });

  it("can also take the action name from payload.action", () => {
    const spec = makeSpec([
      { on: "b.click", emit: "action.invoke", payload: { action: "del", id: "$value.id" } },
    ]);
    const r = resolveInvokeTarget(spec, makeNode("b"), "click", { value: { id: 2 } }, { hasBinding: true });
    expect(r).toEqual({ kind: "invoke", action: "del", payload: { action: "del", id: 2 } });
  });

  it("auto-supplies the row context when runtime.row is unspecified", () => {
    const spec = makeSpec([{ on: "b.click", emit: "action.invoke", payload: { region: "$row.region" } }]);
    const r = resolveInvokeTarget(
      spec,
      makeNode("b", { action: "a" }),
      "click",
      {},
      { hasBinding: true, row: { region: "japan" } },
    );
    expect(r).toMatchObject({ kind: "invoke", action: "a", payload: { region: "japan" } });
  });
});

describe("resolveActionName", () => {
  it("prefers props.action, then payload.action, then undefined if neither", () => {
    expect(resolveActionName(makeNode("b", { action: "p" }), { action: "q" })).toBe("p");
    expect(resolveActionName(makeNode("b"), { action: "q" })).toBe("q");
    expect(resolveActionName(makeNode("b"), {})).toBeUndefined();
    expect(resolveActionName(makeNode("b", { action: "" }), {})).toBeUndefined();
  });
});

const NOTE_SCHEMA = {
  type: "object" as const,
  properties: { note: { type: "string" as const, maxLength: 5 } },
};

describe("preflightAction (design.md #62/#63)", () => {
  it("no manifest -> allow", () => {
    expect(preflightAction(undefined, "annotate", { note: "hi" })).toEqual({ kind: "allow" });
  });

  it("action absent from the manifest -> allow (unknown to this check)", () => {
    const manifest: ActionManifest = { publish: { tier: "auto" } };
    expect(preflightAction(manifest, "annotate", { note: "hi" })).toEqual({ kind: "allow" });
  });

  it("tier auto with a valid payload -> allow", () => {
    const manifest: ActionManifest = { annotate: { tier: "auto", paramsSchema: NOTE_SCHEMA } };
    expect(preflightAction(manifest, "annotate", { note: "hi" })).toEqual({ kind: "allow" });
  });

  it("an invalid payload -> invalid with issues, regardless of tier", () => {
    const manifest: ActionManifest = { annotate: { tier: "confirm", paramsSchema: NOTE_SCHEMA } };
    expect(preflightAction(manifest, "annotate", { note: "way too long" })).toEqual({
      kind: "invalid",
      issues: [{ path: "note", code: "maxLength", message: "expected at most 5 characters" }],
    });
  });

  it("tier confirm with a valid payload -> confirm, carrying confirmMessage", () => {
    const manifest: ActionManifest = {
      annotate: { tier: "confirm", paramsSchema: NOTE_SCHEMA, confirmMessage: "Are you sure?" },
    };
    expect(preflightAction(manifest, "annotate", { note: "hi" })).toEqual({
      kind: "confirm",
      confirmMessage: "Are you sure?",
    });
  });

  it("tier approve with a valid payload -> approve", () => {
    const manifest: ActionManifest = { publish: { tier: "approve" } };
    expect(preflightAction(manifest, "publish", {})).toEqual({ kind: "approve" });
  });
});

describe("summarizeActionForModel (never includes payload values)", () => {
  it.each<[ActionPhase, string]>([
    [{ phase: "idle" }, "annotate: not yet attempted"],
    [{ phase: "pending" }, "annotate: in progress"],
    [{ phase: "succeeded", result: { ok: true } }, "annotate: completed"],
    [{ phase: "failed", message: "network error" }, "annotate: failed (network error)"],
    [
      { phase: "awaitingApproval", tier: "confirm", message: "please confirm" },
      "annotate: requires user confirmation before it can run",
    ],
    [
      { phase: "awaitingApproval", tier: "approve", message: "please approve" },
      "annotate: requires approval before it can run",
    ],
  ])("%o -> %s", (phase, expected) => {
    expect(summarizeActionForModel("annotate", phase)).toBe(expected);
  });

  it("an invalid phase's summary carries only path/code metadata, never the submitted value", () => {
    const summary = summarizeActionForModel("annotate", {
      phase: "invalid",
      issues: [{ path: "note", code: "maxLength", message: "expected at most 5 characters" }],
    });
    expect(summary).toBe("annotate: rejected (note: maxLength)");
    expect(summary).not.toContain("way too long"); // the actual submitted value never appears
  });
});

describe("runInvokeTarget (design.md #62/#63 gating)", () => {
  function fakeBinding(invokeAction: BindingClient["invokeAction"]): BindingClient {
    return {
      resolve: async () => {
        throw new Error("not used in these tests");
      },
      invokeAction,
    };
  }

  it("no manifest: proceeds directly to invoke and publishes invalidates on success", async () => {
    const invokeAction = vi.fn(async () => ({ result: { ok: true }, invalidates: ["query://sales/x"] }));
    const publish = vi.fn();
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: { note: "hi" } },
      {
        binding: fakeBinding(invokeAction),
        bus: { ...NOOP_INVALIDATION_BUS, publish },
        onActionResult: undefined,
      },
      "node1",
      (p) => phases.push(p),
    );
    expect(phases.map((p) => p.phase)).toEqual(["pending", "succeeded"]);
    expect(invokeAction).toHaveBeenCalledWith(
      "annotate",
      { note: "hi" },
      { confirmed: undefined, approval: undefined },
    );
    expect(publish).toHaveBeenCalledWith({ refs: ["query://sales/x"] });
  });

  it("a locally-invalid payload short-circuits before ever calling invokeAction", async () => {
    const invokeAction = vi.fn(async () => ({ result: { ok: true } }));
    const manifest: ActionManifest = { annotate: { tier: "auto", paramsSchema: NOTE_SCHEMA } };
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: { note: "way too long" } },
      { binding: fakeBinding(invokeAction), bus: NOOP_INVALIDATION_BUS, actionManifest: manifest },
      "node1",
      (p) => phases.push(p),
    );
    expect(phases).toEqual([
      {
        phase: "invalid",
        issues: [{ path: "note", code: "maxLength", message: "expected at most 5 characters" }],
      },
    ]);
    expect(invokeAction).not.toHaveBeenCalled();
  });

  it("tier confirm without a confirm hook short-circuits to awaitingApproval", async () => {
    const invokeAction = vi.fn(async () => ({ result: { ok: true } }));
    const manifest: ActionManifest = { annotate: { tier: "confirm", confirmMessage: "Sure?" } };
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: { note: "hi" } },
      { binding: fakeBinding(invokeAction), bus: NOOP_INVALIDATION_BUS, actionManifest: manifest },
      "node1",
      (p) => phases.push(p),
    );
    expect(phases).toEqual([{ phase: "awaitingApproval", tier: "confirm", message: "Sure?" }]);
    expect(invokeAction).not.toHaveBeenCalled();
  });

  it("tier confirm with a confirm hook that declines short-circuits to awaitingApproval", async () => {
    const invokeAction = vi.fn(async () => ({ result: { ok: true } }));
    const manifest: ActionManifest = { annotate: { tier: "confirm" } };
    const confirm = vi.fn(async () => false);
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: { note: "hi" } },
      { binding: fakeBinding(invokeAction), bus: NOOP_INVALIDATION_BUS, actionManifest: manifest, confirm },
      "node1",
      (p) => phases.push(p),
    );
    expect(confirm).toHaveBeenCalledWith({ action: "annotate", message: undefined });
    expect(phases).toEqual([
      { phase: "awaitingApproval", tier: "confirm", message: "this action requires confirmation" },
    ]);
    expect(invokeAction).not.toHaveBeenCalled();
  });

  it("tier confirm with an accepting confirm hook invokes with confirmed: true", async () => {
    const invokeAction = vi.fn(async () => ({ result: { ok: true } }));
    const manifest: ActionManifest = { annotate: { tier: "confirm" } };
    const confirm = vi.fn(async () => true);
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: { note: "hi" } },
      { binding: fakeBinding(invokeAction), bus: NOOP_INVALIDATION_BUS, actionManifest: manifest, confirm },
      "node1",
      (p) => phases.push(p),
    );
    expect(phases.map((p) => p.phase)).toEqual(["pending", "succeeded"]);
    expect(invokeAction).toHaveBeenCalledWith(
      "annotate",
      { note: "hi" },
      { confirmed: true, approval: undefined },
    );
  });

  it("tier approve without a requestApproval hook still asks the server once (no approval), so the pending-approval record exists", async () => {
    const approval = {
      requestId: "r1",
      action: "publish",
      tier: "approve" as const,
      payloadHash: "sha256:x",
    };
    const invokeAction = vi.fn(async () => {
      throw new BindingError("APPROVAL_REQUIRED", "this action requires an approval token", {
        status: 403,
        approval,
      });
    });
    const manifest: ActionManifest = { publish: { tier: "approve" } };
    const onActionResult = vi.fn();
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "publish", payload: {} },
      {
        binding: fakeBinding(invokeAction),
        bus: NOOP_INVALIDATION_BUS,
        actionManifest: manifest,
        onActionResult,
      },
      "node1",
      (p) => phases.push(p),
    );
    expect(invokeAction).toHaveBeenCalledTimes(1);
    expect(invokeAction).toHaveBeenCalledWith("publish", {}, { confirmed: undefined, approval: undefined });
    expect(phases).toEqual([
      { phase: "pending" },
      {
        phase: "awaitingApproval",
        tier: "approve",
        message: "this action requires an approval token",
        approval,
      },
    ]);
    expect(onActionResult).not.toHaveBeenCalled();
  });

  it("tier approve with a requestApproval hook that declines also asks the server without approval", async () => {
    const invokeAction = vi.fn(async () => {
      throw new BindingError("APPROVAL_REQUIRED", "this action requires an approval token", {
        status: 403,
      });
    });
    const manifest: ActionManifest = { publish: { tier: "approve" } };
    const requestApproval = vi.fn(async () => undefined);
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "publish", payload: {} },
      {
        binding: fakeBinding(invokeAction),
        bus: NOOP_INVALIDATION_BUS,
        actionManifest: manifest,
        requestApproval,
      },
      "node1",
      (p) => phases.push(p),
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(invokeAction).toHaveBeenCalledWith("publish", {}, { confirmed: undefined, approval: undefined });
    expect(phases.map((p) => p.phase)).toEqual(["pending", "awaitingApproval"]);
  });

  it("tier approve with a requestApproval hook returning a token invokes with that approval", async () => {
    const invokeAction = vi.fn(async () => ({ result: { ok: true } }));
    const manifest: ActionManifest = { publish: { tier: "approve" } };
    const requestApproval = vi.fn(async () => "kohaku-approval.v1.tok");
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "publish", payload: {} },
      {
        binding: fakeBinding(invokeAction),
        bus: NOOP_INVALIDATION_BUS,
        actionManifest: manifest,
        requestApproval,
      },
      "node1",
      (p) => phases.push(p),
    );
    expect(requestApproval).toHaveBeenCalledWith({ action: "publish", payload: {} });
    expect(phases.map((p) => p.phase)).toEqual(["pending", "succeeded"]);
    expect(invokeAction).toHaveBeenCalledWith(
      "publish",
      {},
      { confirmed: undefined, approval: "kohaku-approval.v1.tok" },
    );
  });

  it("a server-rejected ACTION_PARAMS_INVALID maps to phase invalid (no local manifest to catch it first)", async () => {
    const issues: JsonObject[] = [
      { path: "note", code: "maxLength", message: "expected at most 5 characters" },
    ];
    const invokeAction = vi.fn(async () => {
      throw new BindingError("ACTION_PARAMS_INVALID", "action parameters failed validation", {
        status: 422,
        issues: issues as never,
      });
    });
    const onActionResult = vi.fn();
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: { note: "way too long" } },
      { binding: fakeBinding(invokeAction), bus: NOOP_INVALIDATION_BUS, onActionResult },
      "node1",
      (p) => phases.push(p),
    );
    expect(phases).toEqual([{ phase: "pending" }, { phase: "invalid", issues }]);
    expect(onActionResult).not.toHaveBeenCalled();
  });

  it("a server-rejected APPROVAL_REQUIRED maps to phase awaitingApproval, carrying the approval descriptor", async () => {
    const approval = {
      requestId: "r1",
      action: "annotate",
      tier: "confirm" as const,
      payloadHash: "sha256:x",
    };
    const invokeAction = vi.fn(async () => {
      throw new BindingError("APPROVAL_REQUIRED", "this action requires confirmation (confirmed: true)", {
        status: 403,
        approval,
      });
    });
    const onActionResult = vi.fn();
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: { note: "hi" } },
      { binding: fakeBinding(invokeAction), bus: NOOP_INVALIDATION_BUS, onActionResult },
      "node1",
      (p) => phases.push(p),
    );
    expect(phases).toEqual([
      { phase: "pending" },
      {
        phase: "awaitingApproval",
        tier: "confirm",
        message: "this action requires confirmation (confirmed: true)",
        approval,
      },
    ]);
    expect(onActionResult).not.toHaveBeenCalled();
  });

  it("a generic invoke failure still maps to phase failed and notifies onActionResult (unchanged pre-existing behavior)", async () => {
    const invokeAction = vi.fn(async () => {
      throw new Error("boom");
    });
    const onActionResult = vi.fn();
    const phases: ActionPhase[] = [];
    await runInvokeTarget(
      { kind: "invoke", action: "annotate", payload: {} },
      { binding: fakeBinding(invokeAction), bus: NOOP_INVALIDATION_BUS, onActionResult },
      "node1",
      (p) => phases.push(p),
    );
    expect(phases).toEqual([{ phase: "pending" }, { phase: "failed", message: "boom" }]);
    expect(onActionResult).toHaveBeenCalledWith({
      componentId: "node1",
      action: "annotate",
      phase: "failed",
      message: "boom",
    });
  });
});

describe("actionPhaseNotice", () => {
  it("reports a rejected payload as an alert carrying the issue count", () => {
    const phase: ActionPhase = {
      phase: "invalid",
      issues: [{ path: "note", code: "maxLength", message: "too long" }],
    };
    expect(actionPhaseNotice(phase, DEFAULT_MESSAGES)).toEqual({
      role: "alert",
      text: DEFAULT_MESSAGES.actionInvalid(1),
    });
  });

  it("reports a pending confirmation / approval as a non-interrupting status", () => {
    expect(
      actionPhaseNotice({ phase: "awaitingApproval", tier: "confirm", message: "m" }, DEFAULT_MESSAGES),
    ).toEqual({ role: "status", text: DEFAULT_MESSAGES.actionAwaiting("confirm") });
    expect(
      actionPhaseNotice({ phase: "awaitingApproval", tier: "approve", message: "m" }, DEFAULT_MESSAGES)?.text,
    ).toBe(DEFAULT_MESSAGES.actionAwaiting("approve"));
    expect(DEFAULT_MESSAGES.actionAwaiting("confirm")).not.toBe(DEFAULT_MESSAGES.actionAwaiting("approve"));
  });

  it("appends the request id and the truncated payload hash when the server's descriptor is known", () => {
    const payloadHash = `sha256:${"cd".repeat(32)}`;
    const notice = actionPhaseNotice(
      {
        phase: "awaitingApproval",
        tier: "approve",
        message: "m",
        approval: { requestId: "req-7", action: "annotate", tier: "approve", payloadHash },
      },
      DEFAULT_MESSAGES,
    );
    expect(notice).toEqual({
      role: "status",
      text: `${DEFAULT_MESSAGES.actionAwaiting("approve")} (request req-7 · payload cdcdcdcdcdcd)`,
    });
    expect(DEFAULT_MESSAGES.actionApprovalPrompt("annotate")).toContain('"annotate"');
  });

  it("hands the dictionary the already-shortened hash, so a custom dictionary never re-derives it", () => {
    const seen: string[] = [];
    const messages = {
      ...DEFAULT_MESSAGES,
      actionAwaitingApprovalDetail: (requestId: string, shortHash: string) => {
        seen.push(shortHash);
        return `${requestId}/${shortHash}`;
      },
    };
    const notice = actionPhaseNotice(
      {
        phase: "awaitingApproval",
        tier: "approve",
        message: "m",
        approval: { requestId: "r", action: "a", tier: "approve", payloadHash: `sha256:${"ab".repeat(32)}` },
      },
      messages,
    );
    expect(seen).toEqual(["abababababab"]);
    expect(notice?.text).toContain("r/abababababab");
  });

  it("has no notice for the other phases", () => {
    for (const phase of [
      { phase: "idle" },
      { phase: "pending" },
      { phase: "succeeded", result: null },
      { phase: "failed", message: "x" },
    ] satisfies ActionPhase[]) {
      expect(actionPhaseNotice(phase, DEFAULT_MESSAGES)).toBeNull();
    }
  });
});

describe("shouldPromptForApproval", () => {
  it("is true only for an approve-tier phase that is already awaiting approval", () => {
    expect(shouldPromptForApproval({ phase: "awaitingApproval", tier: "approve", message: "m" })).toBe(true);
    expect(shouldPromptForApproval({ phase: "awaitingApproval", tier: "confirm", message: "m" })).toBe(false);
    expect(shouldPromptForApproval({ phase: "pending" })).toBe(false);
    expect(shouldPromptForApproval({ phase: "idle" })).toBe(false);
    expect(shouldPromptForApproval(undefined)).toBe(false);
  });
});

describe("shortPayloadHash", () => {
  it("drops the sha256: prefix and keeps the first 12 hex characters", () => {
    expect(shortPayloadHash(`sha256:${"0123456789abcdef".repeat(4)}`)).toBe("0123456789ab");
    expect(shortPayloadHash("0123456789abcdef")).toBe("0123456789ab");
    expect(shortPayloadHash("sha256:x")).toBe("x");
  });
});
