/**
 * A bad command-line argument of a subcommand (`evidence export`, `usage export`, `explain`): the CLI exits 2
 * for it, like commander's own usage errors, so it can be told apart from a runtime failure (exit 1).
 *
 * Dependency-free on purpose: `header-args.ts` and `lineage-window.ts` import it, and `index.ts` loads it lazily
 * so that `--help` stays light.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
