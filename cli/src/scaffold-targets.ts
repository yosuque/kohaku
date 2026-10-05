// The `kohaku scaffold <what>` targets: default output directory, post-generation "next steps" and the files
// each one writes. Light on purpose (it imports only the embedded templates), so `index.ts` can load it to
// validate the target without paying for the heavy `commands.ts`.
import { join } from "node:path";
import {
  GOLDEN_README_TEMPLATE,
  GOLDEN_TEST_TEMPLATE,
  INTENTS_TEMPLATE,
  PORTS_TEMPLATE,
  SERVER_TEMPLATE,
} from "./templates.js";

/** One scaffold file: its path and its content. */
export type ScaffoldFile = readonly [path: string, content: string];

export interface ScaffoldTarget {
  /** Output directory used when `--out` is not given. */
  defaultOut: string;
  /** The "Next steps" line printed after generation. */
  next: string;
  /** The files to generate under `outDir` (written atomically by `writeScaffold`). */
  files(outDir: string): readonly ScaffoldFile[];
}

/** `scaffold ports`: the DomainPort, an Intent catalog, and a Hono server built on createKohakuHost(). */
export const PORTS_TARGET: ScaffoldTarget = {
  defaultOut: "./kohaku-ports",
  next: "Implement the TODOs in ports.ts and intents.ts, then start server.ts.",
  files: (outDir) => [
    [join(outDir, "ports.ts"), PORTS_TEMPLATE],
    [join(outDir, "intents.ts"), INTENTS_TEMPLATE],
    [join(outDir, "server.ts"), SERVER_TEMPLATE],
  ],
};

/**
 * `scaffold golden`: the Golden Spec regression scaffold. golden.test.ts (runGolden wiring + update-procedure
 * comments) and golden/README.md (the fixture format).
 */
export const GOLDEN_TARGET: ScaffoldTarget = {
  defaultOut: "./kohaku-golden",
  next: "Wire up makeContext in golden.test.ts, add *.json files under golden/, then generate the expected specs with KOHAKU_GOLDEN_UPDATE=1.",
  files: (outDir) => [
    [join(outDir, "golden.test.ts"), GOLDEN_TEST_TEMPLATE],
    [join(outDir, "golden", "README.md"), GOLDEN_README_TEMPLATE],
  ],
};

/** The scaffold targets by the `<what>` argument. */
export const SCAFFOLD_TARGETS: Record<string, ScaffoldTarget> = {
  ports: PORTS_TARGET,
  golden: GOLDEN_TARGET,
};
