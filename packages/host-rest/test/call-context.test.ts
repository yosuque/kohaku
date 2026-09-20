import { describe, expect, it } from "vitest";
import type { KohakuHostDeps } from "../src/index.js";
import { errorReporterFor, reportHostError } from "../src/routes/shared.js";

// Unit coverage for errorReporterFor (routes/shared.ts): the per-handler shorthand that binds a fixed
// (endpoint, requestId) pair so a handler using reportHostError two or more times can call `report(e)`
// instead of repeating both. It must forward to deps.onError exactly like a direct reportHostError call —
// same shape, same fail-open (swallow-on-throw) behavior — since it is nothing more than a thin wrapper
// (see its doc comment in shared.ts).

/** A minimal KohakuHostDeps stub — errorReporterFor only ever touches deps.onError. */
function depsWithOnError(onError: KohakuHostDeps["onError"]): KohakuHostDeps {
  return { onError } as KohakuHostDeps;
}

describe("errorReporterFor (host-rest)", () => {
  it("report(e) forwards endpoint/requestId/error to deps.onError exactly like a direct reportHostError call", async () => {
    const viaReporter: { endpoint: string; requestId: string; error: unknown }[] = [];
    const viaDirectCall: { endpoint: string; requestId: string; error: unknown }[] = [];
    const error = new Error("boom");

    const reporterDeps = depsWithOnError((info) => {
      viaReporter.push(info);
    });
    const { report } = errorReporterFor(reporterDeps, { endpoint: "compose", requestId: "req-1" });
    await report(error);

    const directDeps = depsWithOnError((info) => {
      viaDirectCall.push(info);
    });
    await reportHostError(directDeps, "compose", "req-1", error);

    expect(viaReporter).toEqual(viaDirectCall);
    expect(viaReporter).toEqual([{ endpoint: "compose", requestId: "req-1", error }]);
  });

  it("is fail-open: report(e) swallows a throwing onError hook instead of propagating it", async () => {
    const deps = depsWithOnError(() => {
      throw new Error("hook error");
    });
    const { report } = errorReporterFor(deps, { endpoint: "events", requestId: "req-2" });
    await expect(report(new Error("original"))).resolves.toBeUndefined();
  });
});
