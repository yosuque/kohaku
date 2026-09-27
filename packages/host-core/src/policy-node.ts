import { readFile } from "node:fs/promises";
import { type ParsedPolicy, parsePolicy } from "./policy.js";

/**
 * Node-only half of the Policy-as-Code runtime: reads a policy file from disk and validates it
 * (`parsePolicy`). Deliberately kept out of the package's main entry point and this file's sibling
 * `policy.js` — the only `node:fs` import in this package — and exposed instead via the
 * `@kohaku-ui/host-core/policy-node` subpath, so a consumer with a non-Node tsconfig can import
 * everything else in this package (including `createPolicyRuntime` itself) without pulling in a
 * Node-only API transitively.
 */
export async function loadPolicyFile(path: string): Promise<ParsedPolicy> {
  const raw = await readFile(path, "utf8");
  return parsePolicy(JSON.parse(raw));
}

export { type ParsedPolicy, parsePolicy } from "./policy.js";
