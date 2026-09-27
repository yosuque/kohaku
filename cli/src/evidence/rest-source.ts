import type { KohakuClient } from "@kohaku-ui/client";
import type { EvidenceSource } from "@kohaku-ui/lineage";
import type { FixationRecord, LineageEventRecord, PromotionState } from "@kohaku-ui/spec-core";

/**
 * Adapts a REST `KohakuClient` into an `EvidenceSource` for `kohaku evidence export --rest`.
 *
 * Tenant scoping over REST happens through the client's own request headers (set at construction, e.g.
 * `--header x-kohaku-tenant:acme`), not a per-call parameter -- `LineageQuery` (client.ts) has no `tenant`
 * field, and neither does `/promotions` or `/fixations`. The `tenant` argument each `EvidenceSource` method
 * receives (from `EvidencePackScope.tenant`) is therefore only stamped onto the records this adapter
 * constructs (so the exported files carry a consistent `tenant` field), not sent as a request parameter.
 *
 * Two REST-specific gaps, both accepted rather than fabricated data to fill them:
 * - `listLineage` (the bounded fallback) always throws: `lineagePages` (used by `pageLineage` below) already
 *   walks the whole log exhaustively, so there is no REST equivalent of a merely-bounded tail read, and
 *   `buildEvidencePack` never calls `listLineage` while `pageLineage` is present anyway.
 * - `listFixations` always returns `[]`: `GET /fixations`'s response (`FixationRecordView`) carries only
 *   `{intentHash, canonical, fixatedAt}`, not the `structureHash` / `pinnedSpec` / `approver` a `FixationRecord`
 *   requires. Fabricating placeholders for a compliance artifact would be worse than omitting the section
 *   outright; the caller (see `export.ts`) records this gap on `manifest.warnings` instead. A `--data-dir`
 *   export (direct `StoragePort` access) does not have this limitation.
 */
export function createRestEvidenceSource(client: KohakuClient): EvidenceSource {
  return {
    async listLineage(): Promise<LineageEventRecord[]> {
      throw new Error(
        "createRestEvidenceSource has no bounded listLineage fallback (pageLineage is always used instead)",
      );
    },
    async pageLineage(req) {
      // client.lineagePages already performs the full exhaustive forward walk (its own cursor loop over
      // GET /lineage?order=asc); this adapter drains it into a single EvidenceSource page rather than
      // re-exposing REST's own pagination through the EvidenceSource contract.
      const events: LineageEventRecord[] = [];
      for await (const page of client.lineagePages({
        since: req.since,
        until: req.until,
        pageSize: req.pageSize,
      })) {
        events.push(...page);
      }
      return { events };
    },
    async listPromotionStates(tenant): Promise<PromotionState[]> {
      const candidates = await client.promotions.list();
      return candidates.map((c) => {
        const data: Record<string, unknown> = {};
        if (c.request != null) data.request = c.request;
        if (c.html != null) data.html = c.html;
        if (c.verdict != null) data.verdict = c.verdict;
        if (c.suggestion != null) data.suggestion = c.suggestion;
        data.uses = c.uses;
        data.sessions = c.sessions;
        return {
          artifactId: c.artifactId,
          status: c.status,
          updatedAt: c.updatedAt,
          data,
          ...(tenant != null ? { tenant } : {}),
        };
      });
    },
    async listFixations(): Promise<FixationRecord[]> {
      return [];
    },
  };
}

/** The warning recorded on the manifest when a REST-sourced export's fixations.jsonl is empty for the
 * structural reason documented on `createRestEvidenceSource` above (used by `export.ts`). */
export const REST_FIXATIONS_LIMITATION_WARNING =
  "REST-sourced export: fixations.jsonl is empty. GET /fixations exposes only " +
  "{intentHash, canonical, fixatedAt}, not the structureHash / pinnedSpec / approver a FixationRecord " +
  "requires, and this export does not fabricate placeholders for a compliance artifact. Use " +
  "--data-dir against the host's own data directory for a complete export.";
