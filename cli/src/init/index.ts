import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { writeScaffold } from "../scaffold-fs.js";
import { type DatasetProfile, inferProfile, normalizeRows, slugify } from "./infer.js";
import { readDataFile } from "./readers.js";
import {
  type ProjectFile,
  renderClaudeDesktopConfigExample,
  renderEnvFile,
  renderProjectFiles,
} from "./render.js";

export interface InitOptions {
  from: string;
  out?: string;
  source?: string;
  name?: string;
  table?: string;
  install?: boolean;
  /**
   * Also generates the MCP front door (server/mcp-server.ts, server/mcp.ts stdio, server/mcp-http.ts
   * Streamable HTTP), on top of the REST front door that is always generated. Default false.
   */
  mcp?: boolean;
  /**
   * Generates the value written to the generated project's `.env` as `KOHAKU_CAPABILITY_SECRET`.
   * Default: a fresh cryptographically random secret (`randomBytes(32).toString("base64url")`). Overridable
   * so callers -- tests, in particular, which need deterministic output -- can inject a fixed value.
   */
  secret?: () => string;
}

export interface InitResult {
  outDir: string;
  written: string[];
  profile: DatasetProfile;
  installed: boolean;
  /**
   * True when the post-install `vitest run` wrote `test/golden/*.json`'s `expected`, so `npm test` is green
   * from the start. False for `install: false`, and when that step failed (init itself does not fail then).
   */
  goldenGenerated: boolean;
  /** The npm package name actually used (see `initProject`'s name-derivation notes). */
  name: string;
}

export interface InitIo {
  /**
   * Runs a child process. `opts.env` is overlaid on `process.env`; a key whose value is `undefined` is
   * removed from the child's environment (used to drop `CI`, which the golden test refuses to update under).
   */
  run?: (cmd: string, args: string[], cwd: string, opts?: { env?: NodeJS.ProcessEnv }) => Promise<number>;
  /** Progress output (default `console.log`). */
  log?: (line: string) => void;
}

/**
 * The environment of a child process: `overrides` laid over `base`, where a key whose override value is
 * `undefined` is removed. spawn ignores `undefined` values on POSIX, but they are deleted explicitly here so
 * Windows behaves the same (and so the result can be asserted on).
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

function defaultRun(
  cmd: string,
  args: string[],
  cwd: string,
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const env = buildChildEnv(process.env, opts?.env);
    const child = spawn(cmd, args, { cwd, env, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}

// A conservative subset of npm's own package-name rule (see npm/validate-npm-package-name): lowercase
// letters, digits, ".", "_", "-" only, must not start with "." or "_", max 214 characters. This name is
// substituted, unescaped, into the generated package.json's "name" field and index.html's <title>, so it
// is validated here, at the point the argument (--name, or the output directory's basename) enters the
// command, rather than trusted through to the templates.
const NPM_PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const NPM_PACKAGE_NAME_MAX_LENGTH = 214;

// Used only when the output directory's basename has nothing a project name could sensibly be
// derived from at all (the filesystem root, or a "." / ".." basename -- the latter shouldn't reach
// here in practice since `initProject` resolves `outDir` first, but a literal, readable fallback
// is kept here rather than relying on that always holding). This is distinct from `slugify`'s own
// sha256-hash fallback (used for e.g. a directory named entirely in a non-Latin script): that hash
// is still a real, if unhelpful, derived name, whereas "", ".", ".." carry no name at all.
const DEFAULT_PROJECT_NAME = "kohaku-app";

function defaultSecret(): string {
  return randomBytes(32).toString("base64url");
}

function isValidProjectName(name: string): boolean {
  return name.length > 0 && name.length <= NPM_PACKAGE_NAME_MAX_LENGTH && NPM_PACKAGE_NAME.test(name);
}

export function validateProjectName(name: string): void {
  if (!isValidProjectName(name)) {
    throw new Error(
      `"${name}" is not a valid npm package name (lowercase letters, digits, ".", "_", "-" only; ` +
        `must not start with "." or "_"; max ${NPM_PACKAGE_NAME_MAX_LENGTH} characters). Pass --name to override it.`,
    );
  }
}

/**
 * Derives the package name to use when `--name` is not given: the output directory's own basename,
 * kept as-is when it is already a legal npm package name (e.g. a directory called "my-app"), and
 * otherwise normalized the same way `--source` is already normalized (see `slugify`) rather than
 * rejected outright. `kohaku init` with no flags is the command's headline invocation, and an
 * ordinary directory name -- "My Data", "Sales Dashboard", a repo cloned as "SalesDashboard" --
 * must produce a runnable app, not an error.
 */
export function deriveDefaultName(outDir: string): string {
  const raw = basename(outDir);
  if (isValidProjectName(raw)) return raw;
  if (raw === "" || raw === "." || raw === "..") return DEFAULT_PROJECT_NAME;
  return slugify(raw);
}

/**
 * kohaku init --from <data>: reads the data file, infers column roles, renders the project (server + web + golden
 * test + the normalized data) so that no target file is ever overwritten -- a check-all-then-write pass rejects the
 * whole operation up front if anything in its path already exists, and writes nothing in that case. (It is not
 * crash-safe against a mid-write I/O failure such as a permissions error or a full disk: that can still leave a
 * partial tree, including directories created along the way -- see `writeScaffold`.) Then runs `npm install`.
 */
export async function initProject(options: InitOptions, io: InitIo = {}): Promise<InitResult> {
  const outDir = resolve(options.out ?? ".");
  // An explicit --name is hard-validated below: the user typed that deliberately, so a bad value is
  // an error, not a silent rename. A derived default is normalized instead (see deriveDefaultName)
  // and then validated too -- that should always pass given slugify's guarantees, but validating
  // unconditionally keeps validateProjectName the single source of truth for "is this legal", so a
  // future regression there fails loudly instead of writing a bad package.json silently.
  const name = options.name ?? deriveDefaultName(outDir);
  validateProjectName(name);
  const dataset = await readDataFile(options.from, options.table != null ? { table: options.table } : {});
  const sourceName = options.source ?? basename(options.from, extname(options.from));
  const profile = inferProfile(sourceName, dataset);
  const rows = normalizeRows(dataset, profile);
  const files = renderProjectFiles(profile, rows, { name, mcp: options.mcp === true });
  // `.env` carries a real, randomly generated secret (unlike `.env.example`'s empty placeholder) so the
  // generated project runs immediately; it is added here rather than in renderProjectFiles so that
  // function -- and its own tests -- stay free of randomness.
  const envFile: ProjectFile = { path: ".env", content: renderEnvFile((options.secret ?? defaultSecret)()) };
  // Like .env above, kept out of renderProjectFiles because it needs this run's actual outDir/execPath
  // (an absolute-path config only meaningful for this one install -- Claude Desktop has no shell PATH of
  // its own, so the paths it launches must already be absolute).
  const extraFiles: ProjectFile[] =
    options.mcp === true
      ? [
          envFile,
          {
            path: "claude_desktop_config.example.json",
            content: renderClaudeDesktopConfigExample({ name, outDir, execPath: process.execPath }),
          },
        ]
      : [envFile];
  const written = writeScaffold(
    [...files, ...extraFiles].map((f) => [join(outDir, f.path), f.content] as const),
  );
  let installed = false;
  let goldenGenerated = false;
  if (options.install !== false) {
    const run = io.run ?? defaultRun;
    const code = await run("npm", ["install", "--no-audit", "--no-fund"], outDir);
    if (code !== 0)
      throw new Error(`npm install exited ${code} in ${outDir}; fix the error and run "npm install" again`);
    installed = true;
    // The fixture is rendered with `expected: null` (init never composes), so a plain `npm test` would be red.
    // Write it now, through the same vitest the project just installed. `npx vitest run` rather than
    // `npm test`: it sidesteps npm-script quoting, and CI is removed because the golden test refuses to
    // update under it (same shape as scripts/pack-smoke.mjs). Best-effort: init has already succeeded.
    const log = io.log ?? console.log;
    try {
      const goldenCode = await run("npx", ["vitest", "run"], outDir, {
        env: { KOHAKU_GOLDEN_UPDATE: "1", CI: undefined },
      });
      goldenGenerated = goldenCode === 0;
    } catch {
      goldenGenerated = false;
    }
    log(
      goldenGenerated
        ? "golden: wrote test/golden/*.json expected (npm test is green)"
        : `golden: could not generate expected; run "KOHAKU_GOLDEN_UPDATE=1 npm test" once in ${outDir}`,
    );
  }
  return { outDir, written, profile, installed, goldenGenerated, name };
}
