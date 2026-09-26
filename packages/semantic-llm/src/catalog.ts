import type { IntentDef } from "@kohaku-ui/intents";
import type { IntentValidationIssue, JsonObject } from "@kohaku-ui/spec-core";
import type { z } from "zod";

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
  /**
   * Strict validation for a directly-specified Intent (backs `createLlmSemanticPort`'s `validateIntent`).
   * Unlike `normalizeParams`, a failure carries structured, client-safe issues instead of collapsing to
   * `null`, and an unknown param key is itself an issue rather than being silently stripped the way a plain
   * Zod `.safeParse` would (Zod's non-`strict()` object schemas drop unrecognized keys by default). Optional:
   * a catalog that omits it cannot back this precise a `validateIntent` — see `createLlmSemanticPort`'s
   * fallback (looser: reuses `normalizeParams`, so it cannot distinguish an unknown canonical from invalid
   * params, or report per-key issues).
   */
  validateParams?(
    name: string,
    params: JsonObject,
  ): { ok: true; params: JsonObject } | { ok: false; issues: IntentValidationIssue[] };
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

  validateParams(
    name: string,
    params: JsonObject,
  ): { ok: true; params: JsonObject } | { ok: false; issues: IntentValidationIssue[] } {
    const def = this.defs.get(name);
    if (def == null) {
      return { ok: false, issues: [{ path: "", message: `unknown intent "${name}"` }] };
    }
    // def.params is a plain (non-strict) z.ZodObject, which silently strips unrecognized keys on parse
    // rather than rejecting them -- detect them ourselves first so an unknown param is reported as an issue
    // instead of quietly disappearing from the finalized Intent.
    const shape = def.params.shape as Record<string, z.ZodType>;
    const issues: IntentValidationIssue[] = Object.keys(params)
      .filter((key) => !(key in shape))
      .map((key) => ({ path: key, message: `unknown param "${key}"` }));
    const parsed = def.params.safeParse(params);
    if (issues.length === 0 && parsed.success) {
      return { ok: true, params: parsed.data as JsonObject };
    }
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join(".");
        issues.push({ path, message: path === "" ? issue.message : `param "${path}": ${issue.message}` });
      }
    }
    return { ok: false, issues };
  }
}

export function createIntentCatalog(defs: IntentDef[]): IntentCatalog {
  return new IntentCatalog(defs);
}
