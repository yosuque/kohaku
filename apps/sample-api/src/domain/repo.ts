import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * In-memory repository of sales data.
 * dataVersion is composed of the seed-version tag + the bump count, and becomes a component of the cache key.
 * The seed-version tag is the SEED_VERSION constant plus a shortened content hash of seed/meta.json, so even if you
 * forget to update the constant, dataVersion changes when the content changes, and an old Spec is not kept being
 * served under the same cache key. If meta.json is absent, the constant only (backward compatible).
 * bump simulates a data update (for the cache-invalidation demo).
 */
export class SalesRepo {
  readonly products: Product[];
  readonly records: SalesRecord[];
  readonly targets: SalesTarget[];
  /** The write target of the demo (notes). Like bumpCount below, in-memory only and non-persistent. */
  readonly notes: string[] = [];
  /** The version tag mechanically derived from the seed content (SEED_VERSION + shortened content hash). */
  private readonly seedTag: string;
  /** id -> name lookup (products are immutable, so built once; productName is called per row in aggregation loops). */
  private readonly productNames: Map<string, string>;
  /**
   * The update count for the write demo (the #bump-N component of dataVersion). Like notes, in-memory only and
   * intentionally not persisted: it returns to 0 on process restart, and dataVersion rolls back to the seed baseline
   * (#bump-0). Approval/fixation persist to .data, but the write demo's goal is the feel of "the data version moving",
   * and durability of the state is a non-goal, so they are distinguished.
   */
  private bumpCount = 0;

  constructor() {
    this.products = load("products.json");
    this.records = load("sales-records.json");
    this.targets = load("sales-targets.json");
    const contentHash = readSeedContentHash();
    // dataVersion is assumed to contain no ':' (paging-cursor splitting and cache key), so we append only the 12 hex
    // digits with the "sha256:" scheme stripped to the version tag.
    const hashPart = contentHash != null ? `+${contentHash.replace(/^sha256:/, "").slice(0, 12)}` : "";
    this.seedTag = `${SEED_VERSION}${hashPart}`;
    this.productNames = new Map(this.products.map((p) => [p.id, p.name]));
  }

  dataVersion(): string {
    return `sales@${this.seedTag}#bump-${this.bumpCount}`;
  }

  /** Simulates a data update: advances dataVersion to induce a cache miss */
  bump(): string {
    this.bumpCount++;
    return this.dataVersion();
  }

  /** The demo's write: adds one note and advances the data version (= simulating that the displayed data was updated). */
  annotate(note: string): string {
    this.notes.push(note);
    return this.bump();
  }

  productName(id: string): string {
    return this.productNames.get(id) ?? id;
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
