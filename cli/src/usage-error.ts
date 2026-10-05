/**
 * A bad command-line argument of a subcommand (`evidence export`, `usage export`, `explain`): the CLI exits 2
 * for it, like commander's own usage errors, so it can be told apart from a runtime failure (exit 1).
 *
 * Dependency-free on purpose (it is imported by `header-args.ts`, which must stay light): `lineage-window.ts`
 * re-exports it under the name its callers have always used.
 */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
