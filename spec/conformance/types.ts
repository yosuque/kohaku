export interface ConformanceResult {
  id: string;
  pass: boolean;
  detail?: string;
  skipped?: boolean;
  /**
   * The check could not be attempted at all (e.g. GET /lineage itself returned a non-200 status), as opposed
   * to `skipped` (the check ran and vacuously passed, e.g. zero component.published events). A `notChecked`
   * result never counts toward mustTotal/mustPassed in buildReport — it is folded into notCheckedMustIds
   * instead, the same reporting path a MUST this suite never attempted at all uses, so it neither
   * masquerades as a pass nor blocks CONFORMANT on its own.
   */
  notChecked?: boolean;
}

/** Black-box check target for a REST host. fetch is replaceable (CLI uses real HTTP, tests use app.request). */
export interface RestTarget {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** The Intent used for checking (one the host supports). */
  composeIntent: { canonical: string; params: Record<string, unknown> };
}

export interface ConformanceReport {
  results: ConformanceResult[];
  mustTotal: number;
  mustPassed: number;
  pass: boolean;
  /**
   * MUST requirement IDs not checked by this suite (black-box targets that go unchecked in another profile).
   * Example: --self only checks the spec target, so the REST MUSTs remain here.
   * Prevents mistaking "MUST X/X passed → CONFORMANT" for all MUSTs having passed.
   */
  notCheckedMustIds: string[];
  /**
   * MUST requirement IDs this suite does not check but that are guaranteed by the reference
   * implementation's package tests (manifest's verifiedBy; verification: "reference"). Reported distinctly from "unchecked".
   */
  referenceVerifiedIds: string[];
}
