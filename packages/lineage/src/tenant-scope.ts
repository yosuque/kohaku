/** Tenant narrowing of the governance plane. undefined / {} = all tenants (legacy single-tenant behavior). */
export interface TenantScope {
  tenant?: string;
}

/**
 * Builds the `{ tenant }` fragment for spreading into a persisted record / query filter, omitting the key
 * entirely when tenant is unset so the single-tenant persistence format stays intact (no stray
 * `tenant: undefined` key). Centralizes the `...(tenant != null ? { tenant } : {})` idiom used throughout
 * packages/lineage/src, spread at the position where key order in persisted JSON / event payloads must stay
 * stable: `{ ...rest, ...tenantField(tenant) }`.
 */
export function tenantField(tenant?: string): { tenant: string } | Record<string, never> {
  return tenant != null ? { tenant } : {};
}
