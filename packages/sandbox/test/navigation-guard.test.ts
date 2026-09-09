import { describe, expect, it, vi } from "vitest";
import { createNavigationGuard } from "../src/navigation-guard.js";

describe("createNavigationGuard", () => {
  it("first call is the initial document, second call fires onIllegal exactly once (third call does nothing)", () => {
    const onIllegal = vi.fn();
    const onLoad = createNavigationGuard(onIllegal);

    onLoad(); // the initial srcdoc document
    expect(onIllegal).not.toHaveBeenCalled();

    onLoad(); // an illegal navigation replaced the document
    expect(onIllegal).toHaveBeenCalledTimes(1);

    onLoad(); // any further load is ignored (the frame is already being torn down)
    expect(onIllegal).toHaveBeenCalledTimes(1);
  });
});
