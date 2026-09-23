import type { IntentDef } from "@kohaku-ui/intents";
import type { JsonObject } from "@kohaku-ui/spec-core";

/** The read side of an Intent catalog: what NL / GUI normalization and resolveQuery need. */
export interface IntentCatalogLike {
  get(name: string): IntentDef | undefined;
  list(): IntentDef[];
  names(): string[];
  /**
   * A counter that changes whenever the set of Intents changes (add / remove). Consumers that cache derived
   * data per catalog object (e.g. `renderCatalogDoc`'s prompt-doc cache) key on this in addition to object
   * identity, so a mutation is never served as stale. A catalog that is immutable may omit it; a mutable
   * catalog that omits it cannot be cached safely across a mutation (its consumers fall back to identity-only
   * caching, so callers of a mutable-but-revision-less implementation may see stale cached output).
   */
  readonly revision?: number;
  /** Validates params and returns the normalized form with defaults filled in. Returns null on failure. */
  normalizeParams(name: string, params: JsonObject): JsonObject | null;
}

/** A mutable Intent catalog: the core definitions plus whatever promotion adds (add) or withdraws (remove). */
export class IntentCatalog implements IntentCatalogLike {
  private readonly defs: Map<string, IntentDef>;
  private revisionCounter = 0;

  constructor(defs: IntentDef[]) {
    this.defs = new Map(defs.map((d) => [d.name, d]));
  }

  get(name: string): IntentDef | undefined {
    return this.defs.get(name);
  }

  list(): IntentDef[] {
    return [...this.defs.values()];
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  /** Changes whenever `add` / `remove` actually change the set of Intents (see IntentCatalogLike.revision). */
  get revision(): number {
    return this.revisionCounter;
  }

  add(def: IntentDef): void {
    this.defs.set(def.name, def);
    this.revisionCounter++;
  }

  remove(name: string): void {
    if (this.defs.delete(name)) this.revisionCounter++;
  }

  normalizeParams(name: string, params: JsonObject): JsonObject | null {
    const def = this.defs.get(name);
    if (def == null) return null;
    const parsed = def.params.safeParse(params);
    return parsed.success ? (parsed.data as JsonObject) : null;
  }
}

export function createIntentCatalog(defs: IntentDef[]): IntentCatalog {
  return new IntentCatalog(defs);
}
