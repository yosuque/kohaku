import { describe, expect, it } from "vitest";
import { catalogEntryIdentity, catalogFingerprint, fnv1a64 } from "../src/fingerprint.js";

describe("catalogEntryIdentity", () => {
  it("native entry identity is type@version", () => {
    expect(catalogEntryIdentity({ type: "presentChart", version: "1.1.0" })).toBe("presentChart@1.1.0");
  });

  it("sandbox-template entry folds an fnv1a64 of the html into the identity", () => {
    const html = "<div>A</div>";
    expect(catalogEntryIdentity({ type: "promoted.widget", version: "1.0.0", implementation: { kind: "sandbox-template", html } })).toBe(
      `promoted.widget@1.0.0#${fnv1a64(html)}`,
    );
  });

  it("a deprecated entry appends !deprecated, leaving a non-deprecated entry's identity untouched", () => {
    const base = { type: "presentChart", version: "1.1.0" };
    expect(catalogEntryIdentity(base)).toBe("presentChart@1.1.0");
    expect(catalogEntryIdentity({ ...base, deprecated: true })).toBe("presentChart@1.1.0!deprecated");
    expect(catalogEntryIdentity({ ...base, deprecated: false })).toBe("presentChart@1.1.0");
  });
});

describe("catalogFingerprint", () => {
  it("marking one entry deprecated changes the fingerprint while other entries stay comparable", () => {
    const entries = [
      { type: "layout.stack", version: "1.0.0" },
      { type: "presentChart", version: "1.1.0" },
    ];
    const before = catalogFingerprint(entries);
    const after = catalogFingerprint([entries[0]!, { ...entries[1]!, deprecated: true }]);
    expect(after).not.toBe(before);
  });

  it("is order-independent (sorted join) and deterministic", () => {
    const a = catalogFingerprint([
      { type: "b.part", version: "1.0.0" },
      { type: "a.part", version: "1.0.0" },
    ]);
    const b = catalogFingerprint([
      { type: "a.part", version: "1.0.0" },
      { type: "b.part", version: "1.0.0" },
    ]);
    expect(a).toBe(b);
  });
});
