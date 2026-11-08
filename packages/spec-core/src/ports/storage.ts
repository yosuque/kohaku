import type { UISpec } from "../schema/spec.js";
import type { Principal } from "./domain.js";

/** The persistence record for a lineage event (the strict schema is owned by @kohaku-ui/lineage). */
export interface LineageEventRecord {
  id: string;
  ts: string;
  actor: { kind: "user" | "model" | "system"; id?: string; model?: string };
  type: string;
  payload: Record<string, unknown>;
  tenant?: string;
}

export interface LineageFilter {
  type?: string[];
  artifactId?: string;
  specHash?: string;
  intentHash?: string;
  /** Only events at or after this time (ts >= since, inclusive). Assumes canonical ISO8601. */
  since?: string;
  /**
   * Only events at or before this time (ts <= until, inclusive). Assumes canonical ISO8601.
   * The upper bound paired with `since`, applied **before** the limit tail slice (otherwise the most
   * recent limit events would all be excluded by until and the window would be nearly empty). Returns
   * the most recent limit events in the window = [since, until].
   */
  until?: string;
  limit?: number;
  /**
   * Filter by tenant. When specified, returns only events whose tenant matches (after `normalizeTenant`
   * on both sides, so an empty-string tenant behaves like an omitted one and matches every event,
   * including old ones with no recorded tenant).
   */
  tenant?: string;
  /**
   * Filter by the `correlationId` payload field (exact equality; see `LINEAGE_PAYLOAD_INDEX_FIELDS` for
   * the full set of payload fields a filter can match this way). The `view.*` / `action.*` records
   * host-rest and host-mcp-apps write carry the correlation id of the request that produced them, so
   * one request's events can be pulled together; a product's own instrumentation may stamp the same
   * field with an application-defined identifier. Rows stored before 0.4.0 have none and never match.
   */
  correlationId?: string;
}

/**
 * A forward (append-order) page request over lineage, for a caller that needs to walk the whole log
 * exhaustively (e.g. an export) rather than take the tail window `listLineage` returns. Every
 * `LineageFilter` predicate applies except `limit`, which `pageLineage` has no use for (`pageSize` takes
 * its place). See `StoragePort.pageLineage`'s doc comment for the paging contract itself.
 */
export interface LineagePageRequest extends Omit<LineageFilter, "limit"> {
  /** Opaque cursor from a previous page's `LineagePage.nextCursor`. Omitted = start from the beginning. */
  cursor?: string;
  /** Requested page size. Default `DEFAULT_LINEAGE_PAGE_SIZE`; clamped to `MAX_LINEAGE_PAGE_SIZE`. */
  pageSize?: number;
}

/** One page returned by `StoragePort.pageLineage`. */
export interface LineagePage {
  /** In append order (oldest first within the page), matching the request's filters. */
  events: LineageEventRecord[];
  /**
   * Opaque cursor for the next page. Absent on the last page (nothing further to read). A page may hold
   * fewer than `pageSize` events, even none, and still carry a `nextCursor` (an adapter bounds the work
   * of one call, so a selective filter over a long log can run out of budget before it fills a page);
   * a caller keeps following `nextCursor` until it is absent, whatever the page holds.
   */
  nextCursor?: string;
}

/**
 * Normalizes a tenant identifier: `undefined`, `null`, and `""` all collapse to `undefined`
 * ("unspecified"), everything else passes through unchanged. Every StoragePort tenant parameter (on
 * `PromotionState` / `FixationRecord` / `LineageFilter` and the get/put/list methods below) treats an
 * empty-string tenant as equivalent to omitting it; adapters MUST normalize with this helper before
 * using a tenant to key or filter a record, so `""` and `undefined` can never be keyed or filtered
 * inconsistently against each other.
 */
export function normalizeTenant(tenant?: string | null): string | undefined {
  return tenant == null || tenant === "" ? undefined : tenant;
}

/**
 * A snapshot of the promotion state. **The source of truth for reads is this snapshot** (design.md
 * §9.2). The lineage event log is the source of truth for auditing, but reconstructing state from
 * events (replay recovery) is not implemented, so StoragePort implementers must not mistake this
 * persistence for a "projection that can be reconstructed if lost" — the persistence of
 * putPromotionState / listPromotionStates is the ultimate state authority.
 */
export interface PromotionState {
  artifactId: string;
  status: string;
  updatedAt: string;
  data: Record<string, unknown>;
  /**
   * The tenant that owns the promotion state (the multi-tenant contract). If omitted, it is
   * tenant-neutral (equivalent to a single tenant). StoragePort keys state separation by this value as
   * (tenant, artifactId) (putPromotionState reads state.tenant). artifactId is derived from
   * sha256(content) and is unique across tenants, but status/verdict/draft are governance decisions and
   * progress independently per tenant (multiple tenants may promote the same artifact through their own
   * pipelines).
   */
  tenant?: string;
  /**
   * A per-write token (optional = compatible with records that predate it). The lineage promotion service stamps
   * a fresh one on every write and passes the one it read back as `expectedRevision` (see
   * {@link PutPromotionStateOptions}), which is what lets a `supportsCompareAndSet` adapter reject a write based
   * on a stale read. A StoragePort stores and returns it verbatim and never generates one itself.
   */
  revision?: string;
}

/** The record of L1→L0 fixation. Even with the structure fixed, data stays current via $ref reference-passing. */
export interface FixationRecord {
  intentHash: string;
  canonical: string;
  structureHash: string;
  pinnedSpec: UISpec;
  fixatedAt: string;
  approver: Principal;
  /**
   * The catalog fingerprint at fixation time (optional = compatible with the old fixations.json).
   * Used for staleness detection at materialize time: a fast path that skips revalidation when it
   * matches the current catalog's fingerprint; if it mismatches/is missing, revalidate pinnedSpec
   * against the current catalog.
   */
  catalogFingerprint?: string;
  /**
   * The tenant that owns the fixation (the multi-tenant contract). If omitted, it is tenant-neutral
   * (equivalent to a single tenant). StoragePort keys fixation separation by this value as
   * (tenant, intentHash) (putFixation reads record.tenant).
   */
  tenant?: string;
  /**
   * A per-write token, monotonic within this process (optional = compatible with old records with none). Finer
   * grained than `fixatedAt` (an ms-precision ISO timestamp), which cannot distinguish an unfixate → fixate
   * pair that lands inside the same millisecond. `fixate` stamps a fresh one on every write; the self-healing
   * TOCTOU guard (see `Fixations.invalidate`'s `guard`) compares this when present, falling back to
   * `fixatedAt` for records that predate this field.
   */
  revision?: string;
}

/**
 * Conditional-write option of `putPromotionState` (the optional compare-and-set extension, see
 * `StoragePort.supportsCompareAndSet`). Tri-state: omitted = unconditional; `null` = the state must not
 * exist yet; a string = the stored state's `revision` must equal it. A mismatch throws
 * `StorageConflictError`.
 */
export interface PutPromotionStateOptions {
  expectedRevision?: string | null;
}

/**
 * Conditional-write options of `putFixation`. `ifPresent` (no-op unless a fixation exists) and
 * `expectedRevision` (same tri-state as {@link PutPromotionStateOptions}) combine: `ifPresent` is applied
 * first, so an absent record is a silent no-op even when `expectedRevision` is a string; `ifPresent: true`
 * with `expectedRevision: null` is contradictory ("must exist" and "must not exist") and always throws
 * `StorageConflictError` on a CAS adapter.
 */
export interface PutFixationOptions {
  ifPresent?: boolean;
  expectedRevision?: string | null;
}

/** Conditional-delete option of `deleteFixation`: the stored fixation's `revision` must equal this. */
export interface DeleteFixationOptions {
  expectedRevision?: string;
}

/**
 * The persistence target for cache / lineage / promotion state (RLS multi-tenancy, etc., are the product's choice).
 *
 * **Concurrency contract**: the base StoragePort carries no locking or versioning. Serializing the
 * read-modify-write of a given (tenant, key) — so that two concurrent writers cannot each read the same base
 * state and lose one another's update — is the **host's** responsibility, not the implementation's; the
 * reference host-rest does this with an in-process keyed mutex (`createKeyedMutex` in this package,
 * re-exported by `@kohaku-ui/host-core`, shared by the promotion lock and the fixation lock) and
 * host-mcp-apps wires the same mutex (keyed by
 * `intentHash` alone, since the MCP profile never resolves a tenant) into its fixation self-heal path. That
 * mutex only orders calls **within one process**.
 *
 * **Optional compare-and-set (CAS)**: an adapter that sets `supportsCompareAndSet: true` additionally
 * honors `expectedRevision` on `putPromotionState`, `putFixation` and `deleteFixation`, which makes the
 * read-modify-write safe **across processes** sharing one backend (several host instances on one redis /
 * postgres). `expectedRevision` is tri-state: omitted (`undefined`) = no check (the legacy unconditional
 * write, and what a caller passes for a record that predates `revision`); `null` = the record MUST NOT exist
 * yet; a string = the stored record's `revision` MUST equal it. A mismatch (including a record that is absent
 * when a string was expected) MUST throw `StorageConflictError` and MUST NOT modify anything; the check
 * and the write are one atomic step. An adapter that does not declare `supportsCompareAndSet` MAY ignore the
 * option (unconditional write, as before), so the in-process mutex stays the only protection there; hosts
 * warn about such an adapter at start-up. The conditional-write option `ifPresent` on `putFixation` is an
 * older, independent hook that narrows one specific race (a stale self-heal resurrecting a fixation deleted
 * by another writer).
 */
export interface StoragePort {
  /**
   * Declares that this adapter honors `expectedRevision` on `putPromotionState` / `putFixation` /
   * `deleteFixation` atomically across processes (see the concurrency contract above and
   * `describeStoragePortContract`'s `requireCompareAndSet`). Absent = the adapter ignores the option.
   */
  readonly supportsCompareAndSet?: true;
  getSpecCache(key: string): Promise<UISpec | null>;
  putSpecCache(key: string, spec: UISpec, ttlSeconds?: number): Promise<void>;
  appendLineage(event: LineageEventRecord): Promise<void>;
  listLineage(filter?: LineageFilter): Promise<LineageEventRecord[]>;
  /**
   * Forward (append-order) paging over the lineage log (an optional v0.1 extension; design.md #53). Unlike
   * `listLineage` (a tail window, newest-first semantics via `limit`), this walks the whole log
   * exhaustively from an opaque `cursor` in ascending append order, so a caller (e.g. an export, or a
   * feature that needs every matching event rather than just the most recent ones) can page through
   * without missing or duplicating events across appends that are sequential, or committed before the
   * page that would return them is read. The cursor is a position in allocation order (a sequence number
   * handed out at append time), which is not always visibility order: an append that is still in flight
   * when a page is read (in a database, allocated a lower number but not yet committed) can become
   * visible behind a cursor that has already passed it, and that cursor will not return it. A caller
   * that needs a complete pack under concurrent writes bounds the read with `until` at a time safely in
   * the past. An implementation MUST return events strictly after `req.cursor` (or from the beginning
   * when omitted), in append order, and MUST omit `LineagePage.nextCursor` only when there is nothing
   * further to read; it MAY return a page shorter than `req.pageSize` (or empty) with a `nextCursor`
   * when it stops scanning early to bound the cost of one call. `req.pageSize`
   * defaults to 500 and is clamped to at most 1000. A malformed `cursor` MUST throw rather than silently
   * restart from the beginning or skip to the end. Implementations that omit this method keep the legacy
   * surface (`listLineage` only); a host without it responds to a paging request with 501
   * `NOT_IMPLEMENTED` rather than emulating paging on top of `listLineage` (which cannot express "all
   * events, exhaustively" without re-deriving this same cursor contract at the host layer).
   */
  pageLineage?(req: LineagePageRequest): Promise<LineagePage>;
  /**
   * Gets promotion state. When tenant is specified, returns only that tenant's state.
   * Old (legacy) state with no recorded tenant is treated as tenant-neutral and appears only in a
   * get with tenant unspecified. Storage without tenant support may ignore the 2nd argument, in which
   * case state is shared across tenants (fail-open; real tenant isolation is the product's
   * responsibility, e.g. RLS).
   */
  getPromotionState(artifactId: string, tenant?: string): Promise<PromotionState | null>;
  /**
   * Saves promotion state. Reads state.tenant to key-separate as (tenant, artifactId). With
   * `options.expectedRevision` (honored only by a `supportsCompareAndSet` adapter) the write is conditional
   * on the stored record's `revision`; a mismatch throws `StorageConflictError`.
   */
  putPromotionState(state: PromotionState, options?: PutPromotionStateOptions): Promise<void>;
  /**
   * Saves several promotion states in one call (an optional v0.1 extension; performance only, no new
   * semantics over calling `putPromotionState` once per state). A batch nomination pass (e.g.
   * `nominateEligible` transitioning many candidates from `in_use` to `candidate` at once) would otherwise
   * re-read, re-stringify, and re-write the whole snapshot file once per candidate; a StoragePort that
   * implements this MAY instead fold every state into a single read-modify-write. Implementations that omit
   * it keep the legacy behavior (the caller falls back to looping `putPromotionState`), so this is purely
   * additive and never widens what a caller could already do without it. The batch write carries no
   * `expectedRevision` (it is unconditional even on a `supportsCompareAndSet` adapter): its only caller,
   * the policy-driven `in_use` -> `candidate` nomination pass, is idempotent and re-derived on the next scan.
   */
  putPromotionStates?(states: PromotionState[]): Promise<void>;
  /** Lists promotion states. When tenant is specified, only that tenant's (unspecified = all = legacy behavior). */
  listPromotionStates(tenant?: string): Promise<PromotionState[]>;
  /**
   * Gets a fixation. When tenant is specified, returns only that tenant's fixation.
   * Storage without tenant support may ignore the 2nd argument, in which case fixations are shared
   * across tenants (fail-open; real tenant isolation is the product's responsibility, e.g. RLS).
   */
  getFixation(intentHash: string, tenant?: string): Promise<FixationRecord | null>;
  /**
   * Saves a fixation. Reads record.tenant to key-separate as (tenant, intentHash).
   * `options.ifPresent` (optional, additive): when true, the write MUST be a no-op unless a fixation currently
   * exists at (record.tenant, record.intentHash) — used by self-healing's `refreshFingerprint` so a
   * get→put that races with a concurrent delete does not resurrect an already-removed fixation. An
   * implementation that ignores the second parameter keeps the legacy unconditional-write behavior (the
   * option narrows one race; it never widens what the caller could already do without it).
   * `options.expectedRevision` (honored only by a `supportsCompareAndSet` adapter): see
   * {@link PutFixationOptions}.
   */
  putFixation(record: FixationRecord, options?: PutFixationOptions): Promise<void>;
  /** Lists fixations. When tenant is specified, only that tenant's (unspecified = all = legacy behavior). */
  listFixations(tenant?: string): Promise<FixationRecord[]>;
  /**
   * Removes a fixation (an optional v0.1 extension). If unimplemented, unfixate fails (fail-fast; no
   * audit event is recorded either). When tenant is specified, deletes that tenant's fixation. With
   * `options.expectedRevision` (honored only by a `supportsCompareAndSet` adapter) the delete is conditional
   * on the stored fixation's `revision` and throws `StorageConflictError` on a mismatch (an absent
   * fixation also mismatches a string expectation).
   */
  deleteFixation?(intentHash: string, tenant?: string, options?: DeleteFixationOptions): Promise<void>;
}
