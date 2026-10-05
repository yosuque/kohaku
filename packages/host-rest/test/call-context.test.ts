import { describe, expect, it } from "vitest";
import type { KohakuHostDeps } from "../src/index.js";
import { reportHostError } from "../src/routes/shared.js";

// Unit coverage for reportHostError (routes/shared.ts): it forwards to deps.onError with the
// (endpoint, requestId, error) shape and is fail-open (swallow-on-throw). Handlers that report two or more
// times bind it locally (see deliverComposed in compose.ts).

/** A minimal KohakuHostDeps stub — reportHostError only ever touches deps.onError. */
function depsWithOnError(onError: KohakuHostDeps["onError"]): KohakuHostDeps {
  return { onError } as KohakuHostDeps;
}

describe("reportHostError (host-rest)", () => {
  it("forwards endpoint/requestId/error to deps.onError", async () => {
    const seen: { endpoint: string; requestId: string; error: unknown }[] = [];
    const error = new Error("boom");

    await reportHostError(
      depsWithOnError((info) => {
        seen.push(info);
      }),
      "compose",
      "req-1",
      error,
    );

    expect(seen).toEqual([{ endpoint: "compose", requestId: "req-1", error }]);
  });

  it("is fail-open: swallows a throwing onError hook instead of propagating it", async () => {
    const deps = depsWithOnError(() => {
      throw new Error("hook error");
    });
    await expect(reportHostError(deps, "events", "req-2", new Error("original"))).resolves.toBeUndefined();
  });
});
