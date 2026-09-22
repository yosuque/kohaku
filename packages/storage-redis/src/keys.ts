/**
 * Key layout of the Redis StoragePort. Every key starts with a configurable prefix (default "kohaku") so
 * several kohaku hosts can share one Redis database. Tenant-scoped kinds (promotion / fixation) put the
 * tenant right after the prefix: `{prefix}:{tenant}:{kind}:{id}`; a tenant-neutral record (no tenant = the
 * single-tenant / legacy contract) uses "%" as its tenant segment, which a real tenant can never produce
 * because tenants are percent-encoded ("%" itself becomes "%25").
 */
export const DEFAULT_KEY_PREFIX = "kohaku";

export const NEUTRAL_TENANT_SEGMENT = "%";

export function tenantSegment(tenant: string | undefined): string {
  return tenant == null || tenant === "" ? NEUTRAL_TENANT_SEGMENT : encodeURIComponent(tenant);
}

export interface RedisKeys {
  spec(key: string): string;
  lineage: {
    seq: string;
    events: string;
    bySeq: string;
    index(field: string, value: string): string;
  };
  promotion(tenant: string | undefined, artifactId: string): string;
  /** Per-tenant index when a tenant is given; the all-tenants index otherwise. */
  promotionIndex(tenant: string | undefined): string;
  promotionSeq: string;
  fixation(tenant: string | undefined, intentHash: string): string;
  fixationIndex(tenant: string | undefined): string;
  fixationSeq: string;
}

export function redisKeys(prefix: string = DEFAULT_KEY_PREFIX): RedisKeys {
  return {
    spec: (key) => `${prefix}:spec:${key}`,
    lineage: {
      seq: `${prefix}:lineage:seq`,
      events: `${prefix}:lineage:events`,
      bySeq: `${prefix}:lineage:by-seq`,
      index: (field, value) => `${prefix}:lineage:idx:${field}:${value}`,
    },
    promotion: (tenant, artifactId) => `${prefix}:${tenantSegment(tenant)}:promotion:${artifactId}`,
    promotionIndex: (tenant) =>
      tenant == null || tenant === ""
        ? `${prefix}:promotion:index`
        : `${prefix}:${tenantSegment(tenant)}:promotion:index`,
    promotionSeq: `${prefix}:promotion:seq`,
    fixation: (tenant, intentHash) => `${prefix}:${tenantSegment(tenant)}:fixation:${intentHash}`,
    fixationIndex: (tenant) =>
      tenant == null || tenant === ""
        ? `${prefix}:fixation:index`
        : `${prefix}:${tenantSegment(tenant)}:fixation:index`,
    fixationSeq: `${prefix}:fixation:seq`,
  };
}
