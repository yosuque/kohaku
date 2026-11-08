import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_ERROR_DISCRIMINATORS,
  isStorageConflictError,
  StorageConflictError,
} from "../src/index.js";

describe("StorageConflictError", () => {
  it("carries the discriminator code, the record kind and the key", () => {
    const e = new StorageConflictError("promotion", "art-1");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("STORAGE_CONFLICT");
    expect(e.code).toBe(GOVERNANCE_ERROR_DISCRIMINATORS.storageConflictCode);
    expect(e.kind).toBe("promotion");
    expect(e.key).toBe("art-1");
    expect(e.message).toBe("storage conflict on promotion art-1");
  });

  it("is recognised by instanceof and by the duck-typed name + code", () => {
    expect(isStorageConflictError(new StorageConflictError("fixation", "h"))).toBe(true);
    const foreign = Object.assign(new Error("x"), { name: "StorageConflictError", code: "STORAGE_CONFLICT" });
    expect(isStorageConflictError(foreign)).toBe(true);
    expect(isStorageConflictError(Object.assign(new Error("x"), { code: "STORAGE_CONFLICT" }))).toBe(false);
    expect(isStorageConflictError("STORAGE_CONFLICT")).toBe(false);
  });
});
