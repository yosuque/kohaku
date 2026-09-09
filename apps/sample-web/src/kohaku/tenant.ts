import { useEffect, useState } from "react";

/**
 * Demo tenant switch (a demonstration of the control plane's tenant-scoping contract).
 * The client just sends the selected tenant in the x-kohaku-tenant header — the compose cache stays tenant-independent
 * (query:// references are tenant-neutral; tenant is not mixed into the cache key. An invariant of SPEC §6.1).
 * What is isolated by tenant is the control/audit plane (lineage / promotion / fixation), not the generated result.
 *
 * "default" maps to "no header = tenant unspecified (equivalent to single-tenant)" (a regression of existing demo behavior).
 * tenant-a / tenant-b are sent with the header = a separated aggregation scope on the server side.
 */
export const TENANTS = ["default", "tenant-a", "tenant-b"] as const;
export type Tenant = (typeof TENANTS)[number];

const STORAGE_KEY = "kohaku.tenant";

function readInitial(): Tenant {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return (TENANTS as readonly string[]).includes(saved ?? "") ? (saved as Tenant) : "default";
  } catch {
    return "default";
  }
}

let current: Tenant = readInitial();
const listeners = new Set<() => void>();

export function getTenant(): Tenant {
  return current;
}

export function setTenant(next: Tenant): void {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // If localStorage is unavailable (private mode, etc.), we simply give up persistence. The switch itself still works.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The tenant header carried on all API calls. "default" maps to unspecified (no header).
 * Called from client.apiFetch / SpecSurface's binding client / composeStreamRequest.
 */
export function tenantHeader(): Record<string, string> {
  return current === "default" ? {} : { "x-kohaku-tenant": current };
}

/** React hook that subscribes to the tenant selection state (used by the App header selector and tenant-dependent re-fetching). */
export function useTenant(): [Tenant, (next: Tenant) => void] {
  const [tenant, setLocal] = useState<Tenant>(current);
  useEffect(() => subscribe(() => setLocal(current)), []);
  return [tenant, setTenant];
}
