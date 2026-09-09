import { useEffect, useState } from "react";

/**
 * Demo role switch (a demonstration of the control plane's declarative RBAC #1).
 * The client just sends the selected role in the x-kohaku-role header — the server (sample-api) resolves
 * principal.roles from the header, and authorizeGovernance (createGovernancePolicy) branches authorization for governance routes.
 * In production, roles are resolved from an auth foundation (JWT/OIDC, etc.) — the header is merely a demo stand-in.
 *
 * "admin" maps to "no header = server default (treated as admin)" (a regression of existing demo behavior; it reproduces
 * with the admin role the legacy behavior where the governance surface let anyone through). reviewer / viewer are sent with
 * the header, and approval/deletion operations return 403.
 */
export const ROLES = ["admin", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const STORAGE_KEY = "kohaku.role";

function readInitial(): Role {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return (ROLES as readonly string[]).includes(saved ?? "") ? (saved as Role) : "admin";
  } catch {
    return "admin";
  }
}

let current: Role = readInitial();
const listeners = new Set<() => void>();

export function getRole(): Role {
  return current;
}

export function setRole(next: Role): void {
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
 * The role header carried on all API calls. "admin" maps to unspecified (no header = server default admin).
 * It merges with tenantHeader in client.ts's header hook.
 */
export function roleHeader(): Record<string, string> {
  return current === "admin" ? {} : { "x-kohaku-role": current };
}

/** React hook that subscribes to the role selection state (used by Admin's role selector and by re-fetching for the 403 banner). */
export function useRole(): [Role, (next: Role) => void] {
  const [role, setLocal] = useState<Role>(current);
  useEffect(() => subscribe(() => setLocal(current)), []);
  return [role, setRole];
}
