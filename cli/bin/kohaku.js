#!/usr/bin/env node
// v0.1 is a monorepo-internal development CLI, so it runs the TS source directly via tsx
// (switch to a prebuild for public distribution).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let tsxCli;
try {
  tsxCli = require.resolve("tsx/cli");
} catch {
  console.error('kohaku: dependencies are not installed. Run "pnpm install" at the repository root.');
  process.exit(1);
}
const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], { stdio: "inherit" }).on(
  "exit",
  (code) => process.exit(code ?? 0),
);
