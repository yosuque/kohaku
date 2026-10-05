import type { Command } from "commander";
import { fail } from "./shared.js";

/** Registers `kohaku scaffold`. The target table and the writer are loaded lazily by the action. */
export function register(program: Command): void {
  program
    .command("scaffold")
    .argument("<what>", '"ports" or "golden"')
    .option("--out <dir>", "Output directory (default depends on the target)")
    .description("Generate scaffolds for product-side Port implementations / Golden regression tests")
    .action(async (what: string, opts: { out?: string }) => {
      // The default output directory, the post-generation "next steps" and the files come from the target's
      // table entry. Validate the target before loading anything else, so that a typo does not pay for (or fail
      // on) a heavy module import; `scaffold-targets.js` itself is light (the embedded templates only).
      const { SCAFFOLD_TARGETS } = await import("../scaffold-targets.js");
      const target = Object.hasOwn(SCAFFOLD_TARGETS, what) ? SCAFFOLD_TARGETS[what] : undefined;
      if (target == null) program.error(`Unknown scaffold target: ${what} (allowed: ports / golden)`);
      const { writeScaffold } = await import("../scaffold-fs.js");
      let written: string[];
      try {
        written = writeScaffold(target.files(opts.out ?? target.defaultOut));
      } catch (e) {
        // As with the conformance action, show failures such as existing-file collisions as a single line (no raw stack).
        fail(program, e);
      }
      console.log("Generated:");
      for (const path of written) console.log(`  ${path}`);
      console.log(`\nNext steps: ${target.next}`);
    });
}
