import type { ComponentDraft } from "@kohaku-ui/lineage";
import type { ResolvedCatalog } from "@kohaku-ui/registry";
import { IntentCatalog } from "./catalog.js";
import { type PromotedEntry, promotedIntent } from "./promoted.js";

/**
 * Per-tenant promotion registry. Holds the components / Intents added by promotion (publish) per tenant, and
 * derives the per-tenant component catalog (for compose) and Intent catalog (for NL normalization).
 *
 * The promotion-state snapshot (promotions.json) is the sole state authority; this registry is its projection.
 * It is rebuilt from the snapshot by startup reconcile (promotions.reconcile -> idempotent re-application of onPublish).
 * onPublish is idempotent (an already-registered (tenant, artifactId) is a no-op), so double application in reconcile is safe.
 *
 * Omitting tenant (single tenant) collapses into the empty-string key bucket (behavior of the existing demo and tests).
 */
const DEFAULT_TENANT_KEY = "";

/**
 * Cap on the number of distinct tenant keys cached in componentCatalogs / intentCatalogs. Tenants are
 * assumed bounded in this demo (a fixed/small set), so there is no eviction policy (LRU, etc.) — on
 * reaching the cap, every cached tenant catalog except the default ("") bucket is cleared naively
 * (same "clear everything, key space is bounded and rarely reached" policy as registry's
 * satisfiesCache — see packages/registry/src/negotiate.ts). This exists only to guard a long-lived
 * process against unbounded growth if that assumption is ever violated (e.g. a per-request synthetic
 * tenant id), not as a real capacity plan.
 */
const TENANT_CATALOG_CACHE_MAX = 64;

function keyOf(tenant?: string): string {
  return tenant ?? DEFAULT_TENANT_KEY;
}

export class PromotedRegistry {
  private readonly byTenant = new Map<string, PromotedEntry[]>();
  private readonly componentCatalogs = new Map<string, ResolvedCatalog>();
  private readonly intentCatalogs = new Map<string, IntentCatalog>();

  /**
   * @param buildComponentCatalog Builds the component catalog including promoted entries (core (+) contributions (+) promotions).
   *   Throws on a componentType collision (the validation point of validate-then-commit).
   * @param coreIntentNames Core Intent names (reserved words). Used to reject promoted Intents that collide with them.
   */
  constructor(
    private readonly buildComponentCatalog: (entries: PromotedEntry[]) => ResolvedCatalog,
    private readonly coreIntentNames: ReadonlySet<string>,
  ) {}

  /** The promotion entries for the given tenant (read-only). */
  entriesFor(tenant?: string): readonly PromotedEntry[] {
    return this.byTenant.get(keyOf(tenant)) ?? [];
  }

  /** The component catalog for the given tenant (for compose; passed to ComposeContext.catalogFor). */
  componentCatalogFor(tenant?: string): ResolvedCatalog {
    const k = keyOf(tenant);
    let catalog = this.componentCatalogs.get(k);
    if (catalog == null) {
      catalog = this.buildComponentCatalog([...this.entriesFor(tenant)]);
      // Guard against unbounded cache growth (see TENANT_CATALOG_CACHE_MAX's doc) before inserting the new
      // entry, so the cap itself never holds more than TENANT_CATALOG_CACHE_MAX + 1 tenants at once.
      if (this.componentCatalogs.size >= TENANT_CATALOG_CACHE_MAX) this.clearCachedTenantCatalogs();
      this.componentCatalogs.set(k, catalog);
    }
    return catalog;
  }

  /**
   * Clears every cached tenant catalog (component + Intent) except the default ("") bucket. Called once
   * componentCatalogs.size reaches TENANT_CATALOG_CACHE_MAX; both maps are cleared together because they
   * track the same tenant key set (invalidate() below always removes from both).
   */
  private clearCachedTenantCatalogs(): void {
    for (const key of [...this.componentCatalogs.keys()]) {
      if (key !== DEFAULT_TENANT_KEY) this.componentCatalogs.delete(key);
    }
    for (const key of [...this.intentCatalogs.keys()]) {
      if (key !== DEFAULT_TENANT_KEY) this.intentCatalogs.delete(key);
    }
  }

  /** The Intent catalog for the given tenant (for NL normalization; base core Intents + the tenant's promoted Intents). */
  intentCatalogFor(tenant?: string): IntentCatalog {
    const k = keyOf(tenant);
    let catalog = this.intentCatalogs.get(k);
    if (catalog == null) {
      catalog = new IntentCatalog(); // already initialized with core INTENT_DEFS
      for (const entry of this.entriesFor(tenant)) catalog.add(promotedIntent(entry));
      this.intentCatalogs.set(k, catalog);
    }
    return catalog;
  }

  /**
   * Pre-check for publish (a pure validation gate, #8). Detects name collisions (with core / the tenant's existing
   * promotions) and componentType collisions before the snapshot transition. If not publishable, throws a
   * Japanese-text error (so the state transition is never reached).
   */
  validatePublish(tenant: string | undefined, entry: PromotedEntry): void {
    const { intentName } = entry.draft;
    const collision = this.intentNameCollision(tenant, intentName);
    if (collision === "core") {
      throw new Error(`Intent name "${intentName}" collides with a core intent and cannot be promoted`);
    }
    if (collision === "promoted") {
      throw new Error(
        `Intent name "${intentName}" collides with an existing promoted intent and cannot be promoted`,
      );
    }
    // A componentType collision is thrown by buildComponentCatalog (detected in a dry-run before the transition).
    this.buildComponentCatalog([...this.entriesFor(tenant), entry]);
  }

  /**
   * Projection application of publish (idempotent, #8). An already-registered (tenant, artifactId) is a no-op (safe for
   * double application in reconcile). validate-then-commit: validate on a copy before applying, and on collision skip
   * applying and warn (the snapshot authority stays published and is retried on the next reconcile). Does not throw
   * (the validation gate is validatePublish).
   */
  publish(tenant: string | undefined, entry: PromotedEntry): void {
    const k = keyOf(tenant);
    const list = this.byTenant.get(k) ?? [];
    if (list.some((e) => e.artifactId === entry.artifactId)) return; // idempotent
    // Skip Intent-name collisions (with a core Intent or the tenant's existing promotion) (reconcile hardening).
    // On the normal path validatePublish rejects them before the transition, but that cannot prevent restoration
    // from a corrupted snapshot, so we also reject here in the projection application to avoid silently overwriting
    // core vocabulary or having a later same-name duplicate win (equivalent to the old buildableEntries).
    const { intentName } = entry.draft;
    if (this.intentNameCollision(tenant, intentName) != null) {
      console.warn(
        `[promoted] skipping ${entry.artifactId} (intent ${intentName}) due to an intent-name collision`,
      );
      return;
    }
    const next = [...list, entry];
    try {
      this.buildComponentCatalog(next); // componentType collision detection (validate-then-commit)
    } catch (err) {
      console.warn(
        `[promoted] skipping ${entry.artifactId} (${entry.draft.componentType}) due to a catalog collision: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.byTenant.set(k, next);
    this.invalidate(k);
  }

  /** Projection removal of unpublish (symmetric with onPublish). A no-op if there is no match (idempotent). */
  unpublish(tenant: string | undefined, artifactId: string): void {
    const k = keyOf(tenant);
    const list = this.byTenant.get(k) ?? [];
    const next = list.filter((e) => e.artifactId !== artifactId);
    if (next.length === list.length) return; // no change
    this.byTenant.set(k, next);
    this.invalidate(k);
  }

  /** Promoted componentTypes across all tenants (deduplicated). Used for the promoted display of /api/health. */
  allPromotedComponentTypes(): string[] {
    const types = new Set<string>();
    for (const list of this.byTenant.values()) {
      for (const e of list) types.add(e.draft.componentType);
    }
    return [...types];
  }

  /**
   * Checks whether intentName collides with a core Intent or an existing promotion for tenant (shared by
   * validatePublish's throw path and publish's warn-and-skip reconcile-hardening path).
   */
  private intentNameCollision(tenant: string | undefined, intentName: string): "core" | "promoted" | null {
    if (this.coreIntentNames.has(intentName)) return "core";
    if (this.entriesFor(tenant).some((e) => e.draft.intentName === intentName)) return "promoted";
    return null;
  }

  private invalidate(k: string): void {
    this.componentCatalogs.delete(k);
    this.intentCatalogs.delete(k);
  }
}

/** Assembles a PromotedEntry from the onPublish/validatePublish arguments (publishedAt is the registry-application time). */
export function toPromotedEntry(args: {
  artifactId: string;
  draft: ComponentDraft;
  html: string;
  request?: string;
  publishedAt: string;
}): PromotedEntry {
  return {
    artifactId: args.artifactId,
    draft: args.draft,
    html: args.html,
    ...(args.request != null ? { request: args.request } : {}),
    publishedAt: args.publishedAt,
  };
}
