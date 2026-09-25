import { normalizeTenant } from "@kohaku-ui/spec-core";

/**
 * Key layout of the Redis StoragePort (and the revocation store). Every key starts with a configurable
 * prefix (default "kohaku") so several kohaku hosts can share one Redis database. Tenant-scoped kinds
 * (promotion / fixation) put the tenant right after the prefix: `{prefix}:{tenant}:{kind}:{id}`; a
 * tenant-neutral record (no tenant = the single-tenant / legacy contract) uses "%" as its tenant segment,
 * which a real tenant can never produce because tenants are percent-encoded ("%" itself becomes "%25").
 *
 * Every key this package writes is defined here -- nothing builds a Redis key string outside this file.
 */
export const DEFAULT_KEY_PREFIX = "kohaku";

export const NEUTRAL_TENANT_SEGMENT = "%";

/** `tenant`, after `normalizeTenant` (`undefined` / `null` / `""` all collapse to "unspecified"), percent-
 * encoded, or `NEUTRAL_TENANT_SEGMENT` when unspecified. */
export function tenantSegment(tenant: string | undefined | null): string {
  const normalized = normalizeTenant(tenant);
  return normalized == null ? NEUTRAL_TENANT_SEGMENT : encodeURIComponent(normalized);
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
  /** Capability revocation record for `jti` (`createRedisRevocationStore`). */
  revoked(jti: string): string;
}

export function redisKeys(prefix: string = DEFAULT_KEY_PREFIX): RedisKeys {
  const tenantOrAllIndex =
    (kind: "promotion" | "fixation") =>
    (tenant: string | undefined): string => {
      const normalized = normalizeTenant(tenant);
      return normalized == null
        ? `${prefix}:${kind}:index`
        : `${prefix}:${tenantSegment(normalized)}:${kind}:index`;
    };
  return {
    spec: (key) => `${prefix}:spec:${key}`,
    lineage: {
      seq: `${prefix}:lineage:seq`,
      events: `${prefix}:lineage:events`,
      bySeq: `${prefix}:lineage:by-seq`,
      index: (field, value) => `${prefix}:lineage:idx:${field}:${value}`,
    },
    promotion: (tenant, artifactId) => `${prefix}:${tenantSegment(tenant)}:promotion:${artifactId}`,
    promotionIndex: tenantOrAllIndex("promotion"),
    promotionSeq: `${prefix}:promotion:seq`,
    fixation: (tenant, intentHash) => `${prefix}:${tenantSegment(tenant)}:fixation:${intentHash}`,
    fixationIndex: tenantOrAllIndex("fixation"),
    fixationSeq: `${prefix}:fixation:seq`,
    revoked: (jti) => `${prefix}:revoked:${jti}`,
  };
}
