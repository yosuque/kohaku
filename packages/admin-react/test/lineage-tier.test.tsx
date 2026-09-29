import type { LineageEventRecord } from "@kohaku-ui/spec-core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultDevToolsMessages } from "../src/devtools/messages.js";
import { LineagePanel } from "../src/devtools/panels/LineagePanel.js";
import { lineageTierCell } from "../src/tiers.js";

const event = (id: string, type: string, payload: Record<string, unknown>): LineageEventRecord => ({
  id,
  ts: "2026-01-01T09:00:00Z",
  actor: { kind: "user" },
  type,
  payload,
});

describe("lineageTierCell", () => {
  it("shows the composition tier for view.* and component.* events", () => {
    expect(lineageTierCell(event("1", "view.composed", { tier: "L1" }))).toMatchObject({
      text: "L1",
      gate: false,
    });
    expect(lineageTierCell(event("2", "component.used", { tier: "L2" }))).toMatchObject({
      text: "L2",
      gate: false,
    });
  });

  it("renders an action.* gate tier distinctly, never as a bare composition tier", () => {
    const cell = lineageTierCell(event("3", "action.approvalRequested", { tier: "approve" }));
    expect(cell).toMatchObject({ text: "gate:approve", gate: true });
    expect(cell?.color).not.toBe(lineageTierCell(event("4", "view.composed", { tier: "L1" }))?.color);
  });

  it("has no tier cell for other events or a non-string tier", () => {
    expect(lineageTierCell(event("5", "intent.fixated", { tier: "L1" }))).toBeNull();
    expect(lineageTierCell(event("6", "view.composed", {}))).toBeNull();
    expect(lineageTierCell(event("7", "view.composed", { tier: 3 }))).toBeNull();
  });
});

describe("LineagePanel tier label", () => {
  it("labels composition and gate tiers differently in one list", () => {
    render(
      <LineagePanel
        events={[
          event("1", "view.composed", { tier: "L1" }),
          event("2", "action.invoked", { tier: "approve" }),
        ]}
        messages={defaultDevToolsMessages}
      />,
    );
    expect(screen.getByText("L1").getAttribute("data-kohaku-tier-kind")).toBe("composition");
    expect(screen.getByText("gate:approve").getAttribute("data-kohaku-tier-kind")).toBe("gate");
    expect(screen.queryByText("approve")).toBeNull();
  });
});
