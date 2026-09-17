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

  it("catches the specific case of a <meta http-equiv=refresh> self-navigation as an ordinary second load", () => {
    // This is the parent-side backstop for the generated-CSS </style> breakout class of bug (see
    // srcdoc.test.ts's "cannot close the trusted <style>" tests, which stop a <meta refresh> from ever
    // becoming a real element in the first place): even if one ever slipped through unescaped and fired a
    // self-navigation, the resulting second `load` event is indistinguishable from — and caught the same way
    // as — any other illegal navigation.
    const onIllegal = vi.fn();
    const onLoad = createNavigationGuard(onIllegal);

    onLoad(); // the initial srcdoc document
    onLoad(); // the meta-refresh-triggered reload
    expect(onIllegal).toHaveBeenCalledTimes(1);
  });
});
