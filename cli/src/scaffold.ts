import { writeScaffold } from "./scaffold-fs.js";
import { GOLDEN_TARGET, PORTS_TARGET } from "./scaffold-targets.js";

/** scaffold ports: generate scaffolds for the DomainPort, an Intent catalog, and a Hono server built on createKohakuHost() */
export function scaffoldPorts(outDir: string): string[] {
  return writeScaffold(PORTS_TARGET.files(outDir));
}

/**
 * scaffold golden: generate the Golden Spec regression scaffold.
 * Atomically places golden.test.ts (runGolden wiring + update-procedure comments) and golden/README.md
 * (the fixture format). The user adds fixtures (*.json), and the expected specs are generated with KOHAKU_GOLDEN_UPDATE=1.
 */
export function scaffoldGolden(outDir: string): string[] {
  return writeScaffold(GOLDEN_TARGET.files(outDir));
}
