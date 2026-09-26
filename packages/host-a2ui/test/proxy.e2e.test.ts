import type { CanonicalIntent, GuiAction } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import {
  fromA2ui,
  parseInboundA2uiMessage,
  reduceSurfaces,
  type SurfaceState,
  serializeA2uiLines,
  toA2ui,
  toA2uiClientAction,
} from "../src/index.js";

const INTENT: CanonicalIntent = {
  canonical: "a2ui.thirdparty.checkout",
  params: {},
  hash: `sha256:${"c".repeat(64)}`,
};

/** A hand-written, schema-valid v0.9.1 message sequence for a third-party checkout surface with a Confirm button. */
const THIRD_PARTY_MESSAGES: unknown[] = [
  {
    version: "v0.9.1",
    createSurface: { surfaceId: "checkout-1", catalogId: "https://vendor.example/catalog.json" },
  },
  {
    version: "v0.9.1",
    updateComponents: {
      surfaceId: "checkout-1",
      components: [
        { id: "root", component: "Column", children: ["summary", "confirm_btn"] },
        { id: "summary", component: "Text", text: "Order #123 — $42.00", variant: "h2" },
        {
          id: "confirm_btn",
          component: "Button",
          child: "confirm_label",
          variant: "primary",
          // A genuinely third-party event name: opaque, no dot, unrelated to kohaku's own "<id>.<eventName>" convention.
          action: { event: { name: "confirm", context: { orderId: "123" } } },
        },
        { id: "confirm_label", component: "Text", text: "Confirm order" },
      ],
    },
  },
];

describe("proxy e2e: third-party A2UI -> ingest -> kohaku Spec event -> A2UI client action -> re-export", () => {
  it("ingests a third-party surface into a UISpec, round-trips a click back to the agent's own action shape, and re-exports it", async () => {
    // 1. Third-party A2UI -> ingest (schema-validate + fold into SurfaceState).
    let surfaces = new Map<string, SurfaceState>();
    for (const raw of THIRD_PARTY_MESSAGES) {
      surfaces = reduceSurfaces(surfaces, parseInboundA2uiMessage(raw));
    }
    const surface = surfaces.get("checkout-1")!;

    // 2. SurfaceState -> kohaku UISpec (fromA2ui).
    const { spec, losses } = fromA2ui(surface, { intent: INTENT, dataVersion: "checkout@v1" });
    expect(losses).toEqual([]);
    const button = spec.components.find((c) => c.id === "confirm_btn")!;
    expect(button).toMatchObject({
      type: "action.button",
      props: { label: "Confirm order", variant: "primary" },
    });
    // The EventBinding is genuinely interactive (emit: action.invoke), not just visually reconstructed.
    expect(spec.events).toEqual([
      { on: "confirm_btn.confirm", emit: "action.invoke", payload: { orderId: "123" } },
    ]);

    // 3. A user clicks the button in kohaku's own renderer: the renderer matches the EventBinding above and
    // produces exactly this GuiAction (simulated here — renderer-core's own emit resolution is out of scope
    // for this package's tests).
    const guiAction: GuiAction = { kind: "gui", action: "confirm_btn.confirm", params: { orderId: "123" } };

    // 4. kohaku Spec event -> A2UI client action (toA2uiClientAction, the reverse of fromA2uiEvent).
    const clientAction = toA2uiClientAction(guiAction);
    // The original agent-facing event name ("confirm") is recovered exactly — not kohaku's own
    // "confirm_btn.confirm" on-string — and the context is passed straight through.
    expect(clientAction).toEqual({ action: { name: "confirm", context: { orderId: "123" } } });

    // 5. Re-export the ingested Spec outward via toA2ui (e.g. relaying it to another A2UI-compatible client).
    const { messages } = await toA2ui(spec, { target: "v1.0" });
    const jsonl = serializeA2uiLines(messages);
    expect(jsonl.split("\n")).toHaveLength(1); // v1.0 bundles everything into one createSurface message
    const reexported = JSON.parse(jsonl.split("\n")[0]!) as {
      createSurface: { components: { id: string; component: string }[] };
    };
    const reexportedIds = reexported.createSurface.components.map((c) => c.id);
    // root / summary / the button / its re-synthesized label all made it back onto the wire.
    expect(reexportedIds).toEqual(expect.arrayContaining(["root", "summary", "confirm_btn"]));
    const reexportedButton = reexported.createSurface.components.find((c) => c.id === "confirm_btn")! as {
      action?: { event?: { name: string } };
    };
    // Re-exported with kohaku's own on-string convention (this is a NEW outbound projection, not a literal
    // passthrough of the original agent's wire bytes — the sidecar-based lossless path is for kohaku's own
    // round trip, not third-party content, which has no sidecar to restore from).
    expect(reexportedButton.action?.event?.name).toBe("confirm_btn.confirm");
  });
});
