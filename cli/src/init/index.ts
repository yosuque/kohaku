import { spawn } from "node:child_process";
import { basename, extname, join, resolve } from "node:path";
import { writeScaffold } from "../commands.js";
import { type DatasetProfile, inferProfile, normalizeRows } from "./infer.js";
import { readDataFile } from "./readers.js";
import { renderProjectFiles } from "./render.js";

export interface InitOptions {
  from: string;
  out?: string;
  source?: string;
  name?: string;
  table?: string;
  install?: boolean;
}

export interface InitResult {
  outDir: string;
  written: string[];
  profile: DatasetProfile;
  installed: boolean;
}

export interface InitIo {
  run?: (cmd: string, args: string[], cwd: string) => Promise<number>;
}

function defaultRun(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
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

export function validateProjectName(name: string): void {
  if (name.length === 0 || name.length > NPM_PACKAGE_NAME_MAX_LENGTH || !NPM_PACKAGE_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a valid npm package name (lowercase letters, digits, ".", "_", "-" only; ` +
        `must not start with "." or "_"; max ${NPM_PACKAGE_NAME_MAX_LENGTH} characters). Pass --name to override it.`,
    );
  }
}

/**
 * kohaku init --from <data>: reads the data file, infers column roles, renders the project (server + web + golden
 * test + the normalized data) atomically (check-all-then-write, never overwriting), then runs `npm install`.
 */
export async function initProject(options: InitOptions, io: InitIo = {}): Promise<InitResult> {
  const outDir = resolve(options.out ?? ".");
  const name = options.name ?? basename(outDir);
  // Validated before anything else touches disk: a bad name (explicit --name, or an output directory
  // whose own basename isn't one) must fail before the data file is even read.
  validateProjectName(name);
  const dataset = await readDataFile(options.from, options.table != null ? { table: options.table } : {});
  const sourceName = options.source ?? basename(options.from, extname(options.from));
  const profile = inferProfile(sourceName, dataset);
  const rows = normalizeRows(dataset, profile);
  const files = renderProjectFiles(profile, rows, { name });
  const written = writeScaffold(files.map((f) => [join(outDir, f.path), f.content] as const));
  let installed = false;
  if (options.install !== false) {
    const code = await (io.run ?? defaultRun)("npm", ["install", "--no-audit", "--no-fund"], outDir);
    if (code !== 0)
      throw new Error(`npm install exited ${code} in ${outDir}; fix the error and run "npm install" again`);
    installed = true;
  }
  return { outDir, written, profile, installed };
}
