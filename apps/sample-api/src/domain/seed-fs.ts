import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SalesSeedInput } from "./repo.js";
import type { Product, SalesRecord, SalesTarget } from "./types.js";

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "seed");
/**
 * A human-readable seed-version label. The mechanical identity of the content is guaranteed by seed/meta.json's
 * contentHash, so this constant only represents a "meaningful version name". Even if you forget to update it, a content
 * change is picked up by the contentHash below.
 */
const SEED_VERSION = "seed-20260610.1";

/** The contentHash of seed/meta.json (the machine-derived version info written by generate-seed). null if unreadable. */
function readSeedContentHash(): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(SEED_DIR, "meta.json"), "utf8")) as {
      contentHash?: unknown;
    };
    return typeof meta.contentHash === "string" && meta.contentHash !== "" ? meta.contentHash : null;
  } catch {
    // If meta.json is not generated (an old seed) or corrupted, fall back to the constant only (backward compatible).
    return null;
  }
}

function load<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(join(SEED_DIR, file), "utf8")) as T;
  } catch (e) {
    throw new Error(
      `Cannot read seed data ${file}. Run \`pnpm seed\` first (${e instanceof Error ? e.message : e})`,
    );
  }
}

/**
 * Reads the demo seed (products / records / targets) plus the derived seedTag from disk (`node:fs`). Node
 * only — this is the file `SalesRepo`'s own module (`repo.ts`, browser-safe) never imports; `app.ts` is the
 * only caller, importing it statically at module load (see `app.ts`'s own doc comment for why a dynamic
 * `import()` behind a variable specifier was tried first and abandoned — it broke Vite/Vitest's SSR module
 * resolution). `app-core.ts` never imports this file at all, so a bundler building for the browser through
 * the `./browser` export (`browser.ts` → `app-core.ts`, never `app.ts`) cannot reach `node:fs` even
 * statically, and a host that always supplies its own seed (the static playground, apps/playground) never triggers it.
 */
export function readSeedFromDisk(): SalesSeedInput {
  const products = load<Product[]>("products.json");
  const records = load<SalesRecord[]>("sales-records.json");
  const targets = load<SalesTarget[]>("sales-targets.json");
  const contentHash = readSeedContentHash();
  // dataVersion is assumed to contain no ':' (paging-cursor splitting and cache key), so we append only the 12 hex
  // digits with the "sha256:" scheme stripped to the version tag.
  const hashPart = contentHash != null ? `+${contentHash.replace(/^sha256:/, "").slice(0, 12)}` : "";
  return { products, records, targets, seedTag: `${SEED_VERSION}${hashPart}` };
}
