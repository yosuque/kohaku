import type { Product, SalesRecord, SalesTarget } from "./types.js";

/**
 * The seed data a `SalesRepo` is built from. Node's default (`createDefaultRepo` in `app.ts`, behind a
 * dynamic import of `seed-fs.ts`) derives this from disk via `readFileSync`; a host with no filesystem
 * (the static playground, apps/playground) builds it from a bundled JSON asset instead and passes it to `SalesRepo`'s
 * constructor directly.
 */
export interface SalesSeedInput {
  products: Product[];
  records: SalesRecord[];
  targets: SalesTarget[];
  /**
   * The version tag mixed into `dataVersion()` (see the class doc). `seed-fs.ts`'s `readSeedFromDisk`
   * derives this from `SEED_VERSION` + a shortened content hash of `seed/meta.json`; a caller supplying its
   * own seed data is responsible for choosing a stable tag itself (e.g. a fixed string is fine when the
   * seed never changes at runtime, as in the playground).
   */
  seedTag: string;
}

/**
 * In-memory repository of sales data (browser-safe: no filesystem access — see `seed-fs.ts` for the Node
 * default that reads real seed data from disk, wired in behind a dynamic import by `app.ts`'s
 * `createDefaultRepo` when no seed is supplied).
 * dataVersion is composed of the seed-version tag + the bump count, and becomes a component of the cache key.
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
  /** The "approve"-tier write demo's counter (design.md #62/#63). Like bumpCount, in-memory only and non-persistent. */
  publishCount = 0;

  constructor(seed: SalesSeedInput) {
    this.products = seed.products;
    this.records = seed.records;
    this.targets = seed.targets;
    this.seedTag = seed.seedTag;
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

  /** The demo's "approve"-tier write (design.md #62/#63): counts a publish and advances the data version. */
  publish(): string {
    this.publishCount++;
    return this.bump();
  }

  productName(id: string): string {
    return this.productNames.get(id) ?? id;
  }
}
