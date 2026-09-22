import type { IntentDef } from "@kohaku-ui/intents";
import type { JsonObject } from "@kohaku-ui/spec-core";

/** The read side of an Intent catalog: what NL / GUI normalization and resolveQuery need. */
export interface IntentCatalogLike {
  get(name: string): IntentDef | undefined;
  list(): IntentDef[];
  names(): string[];
  /** Validates params and returns the normalized form with defaults filled in. Returns null on failure. */
  normalizeParams(name: string, params: JsonObject): JsonObject | null;
}

/** A mutable Intent catalog: the core definitions plus whatever promotion adds (add) or withdraws (remove). */
export class IntentCatalog implements IntentCatalogLike {
  private readonly defs: Map<string, IntentDef>;

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

  add(def: IntentDef): void {
    this.defs.set(def.name, def);
  }

  remove(name: string): void {
    this.defs.delete(name);
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
