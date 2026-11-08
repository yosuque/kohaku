/**
 * Regenerates every generated artifact, in the order CONTRIBUTING.md §5 documents. Run `pnpm regen` after a
 * change that touches more than one of them (or when unsure which apply): each step is idempotent, so a
 * step with nothing to do leaves the tree untouched.
 *
 * Stops at the first failing step. Not covered here because they are edited by hand: the core catalog's
 * fingerprint pins and the docs snippets (see CONTRIBUTING.md §5).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Step {
  /** What the step regenerates, for the progress line. */
  readonly label: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

// Order matters: later steps can read what earlier ones wrote (the init goldens render the version table
// that `init:versions` writes, so it must run before them).
const STEPS: readonly Step[] = [
  { label: "spec/schemas", args: ["--filter", "@kohaku-ui/spec", "run", "generate-schemas"] },
  {
    label: "core catalog JSON (for Python)",
    args: ["--filter", "@kohaku-ui/registry", "run", "export-core-catalog"],
  },
  {
    label: "cross-language fixtures",
    args: ["--filter", "@kohaku-ui/spec", "run", "generate-cross-language-fixtures"],
  },
  { label: "facet-views.json", args: ["intents:emit"] },
  { label: "sales seed", args: ["seed"] },
  { label: "package manifest metadata", args: ["meta:sync"] },
  { label: "Python version", args: ["python:version"] },
  { label: "init version table", args: ["init:versions"] },
  {
    label: "init goldens",
    args: ["vitest", "run", "--project", "cli", "cli/test/init/render-golden.test.ts"],
    env: { KOHAKU_UPDATE_INIT_GOLDEN: "1" },
  },
];

for (const step of STEPS) {
  console.log(`\n==> ${step.label}: pnpm ${step.args.join(" ")}`);
  const result = spawnSync("pnpm", [...step.args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...step.env },
  });
  if (result.status !== 0) {
    // `error` is set when the spawn itself failed (e.g. ENOENT: pnpm is not on PATH); status is then null.
    const reason = result.error?.message ?? `exit ${result.status ?? result.signal}`;
    console.error(`\nregen stopped: "${step.label}" failed (${reason}).`);
    process.exit(result.status ?? 1);
  }
}

console.log("\nregen: every generated artifact is up to date. Review `git diff` before committing.");
