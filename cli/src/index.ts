#!/usr/bin/env node
import { Command } from "commander";
import { register as registerComponent } from "./cli/component.js";
import { register as registerConformance } from "./cli/conformance.js";
import { register as registerDataset } from "./cli/dataset.js";
import { register as registerEvidence } from "./cli/evidence.js";
import { register as registerExplain } from "./cli/explain.js";
import { register as registerInit } from "./cli/init.js";
import { register as registerMigrate } from "./cli/migrate.js";
import { register as registerScaffold } from "./cli/scaffold.js";
import { register as registerSmokeL2 } from "./cli/smoke-l2.js";
import { register as registerUsage } from "./cli/usage.js";
import { CLI_VERSION } from "./version.js";

// The explicit `Command` annotation is load-bearing for the registration modules: each receives this root
// program as an annotated parameter, which is what lets `program.error(...)` / `fail(program, ...)` (see
// cli/shared.ts) narrow the code after a failed `try` without a `return`.
const program: Command = new Command("kohaku")
  .description(
    "CLI for kohaku: protocol conformance checks, scaffolding, project generation and component validation",
  )
  .version(CLI_VERSION);

// Each command's wiring lives in its own module under cli/. The registration order is the order `--help` lists
// the commands in. The modules are light (commander and types only); every action loads its runner through a
// dynamic import, so `--help` never loads a workspace package (test/cli-help.test.ts pins that).
registerConformance(program);
registerExplain(program);
registerScaffold(program);
registerInit(program);
registerSmokeL2(program);
registerComponent(program);
registerDataset(program);
registerEvidence(program);
registerUsage(program);
registerMigrate(program);

await program.parseAsync();
