import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStoragePortContract } from "@kohaku-ui/port-contracts";
import { createFileStoragePort, createMemoryStoragePort } from "../src/index.js";

// Both reference ports implement every optional StoragePort extension, so the suite requires all of them
// (an omitted option would register that extension's cases as skipped).
const ALL_EXTENSIONS = { requirePaging: true, requirePutPromotionStates: true, requireDeleteFixation: true };

describeStoragePortContract(
  "createMemoryStoragePort",
  () => ({ port: createMemoryStoragePort() }),
  ALL_EXTENSIONS,
);

describeStoragePortContract(
  "createFileStoragePort",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-storage-contract-"));
    return { port: createFileStoragePort(dir), dispose: () => rm(dir, { recursive: true, force: true }) };
  },
  ALL_EXTENSIONS,
);
