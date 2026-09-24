import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStoragePortContract } from "@kohaku-ui/port-contracts";
import { createFileStoragePort, createMemoryStoragePort } from "../src/index.js";

describeStoragePortContract("createMemoryStoragePort", () => ({ port: createMemoryStoragePort() }));

describeStoragePortContract("createFileStoragePort", () => {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-storage-contract-"));
  return { port: createFileStoragePort(dir), dispose: () => rm(dir, { recursive: true, force: true }) };
});
