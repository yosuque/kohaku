import type { ComposeContext } from "@kohaku-ui/composer";
import type { AuthzPort, DomainPort } from "@kohaku-ui/spec-core";
import { describe, expect, it } from "vitest";
import { createKohakuRoutes, type KohakuHostDeps, type ViewRecorder } from "../src/index.js";

// Wiring tests for /telemetry's cap clamping and loop robustness (one failure does not drop the rest).
// The telemetry route does not reference compose/authz/domain, so stubs suffice.
const NO_COMPOSE = {} as unknown as ComposeContext;
const NO_AUTHZ = {} as unknown as AuthzPort;
const NO_DOMAIN = {} as unknown as DomainPort;

function post(app: ReturnType<typeof createKohakuRoutes>, body: unknown) {
  return app.request("/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deps(overrides: Partial<KohakuHostDeps> = {}): KohakuHostDeps {
  return {
    compose: NO_COMPOSE,
    domain: NO_DOMAIN,
    authz: NO_AUTHZ,
    querySource: "sales",
    ...overrides,
  };
}

describe("/telemetry limits and loop hardening (host-rest)", () => {
  it("returns 400 BAD_REQUEST when events exceed 500", async () => {
    const app = createKohakuRoutes(deps());
    const events = Array.from({ length: 501 }, () => ({ kind: "rendered", specHash: "h" }));
    const res = await post(app, { events });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("exactly 500 events passes (boundary)", async () => {
    const app = createKohakuRoutes(deps({ recorder: { async composed() {}, async interacted() {} } }));
    const events = Array.from({ length: 500 }, () => ({ kind: "rendered", specHash: "h" }));
    const res = await post(app, { events });
    expect(res.status).toBe(200);
  });

  it("a single recording failure does not drop the remaining events + the failure is notified to the observability hook", async () => {
    const recorded: string[] = [];
    const seen: string[] = [];
    const recorder: ViewRecorder = {
      async composed() {},
      async interacted() {},
      async rendered() {
        throw new Error("rendered recording failed (test)");
      },
      async componentUsed(args) {
        recorded.push(args.artifactId);
      },
    };
    const app = createKohakuRoutes(
      deps({
        recorder,
        onError: (info) => {
          seen.push(info.endpoint);
        },
      }),
    );

    const res = await post(app, {
      events: [
        { kind: "rendered", specHash: "h1" },
        { kind: "componentUsed", artifactId: "a1" },
        { kind: "rendered", specHash: "h2" },
        { kind: "componentUsed", artifactId: "a2" },
      ],
    });
    expect(res.status).toBe(200);

    // Even if both rendered throw, the subsequent componentUsed events are both recorded (not dropped).
    expect(recorded).toEqual(["a1", "a2"]);
    // Both rendered failures are notified to the observability hook.
    expect(seen.filter((e) => e === "telemetry")).toHaveLength(2);
  });
});
