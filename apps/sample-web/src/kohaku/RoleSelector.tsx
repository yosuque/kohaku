import type { ReactNode } from "react";
import { useT } from "../i18n/ui.js";
import { ROLES, type Role, useRole } from "./role.js";

/**
 * Role switch selector (permanently in the App header). The choice is persisted to localStorage and is carried on all
 * subsequent API calls as x-kohaku-role (declarative RBAC #1). Switching to viewer makes Admin's approval/deletion operations
 * return 403 CAPABILITY_DENIED. In production, roles are resolved from an auth foundation (the header is a demo stand-in).
 */
export function RoleSelector(): ReactNode {
  const [role, setRole] = useRole();
  const t = useT();
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: "var(--app-muted, #6b7280)",
      }}
    >
      <span>{t.chrome.roleLabel}</span>
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as Role)}
        aria-label={t.chrome.roleSwitchAria}
        style={{
          border: "1px solid var(--app-border, #e5e7eb)",
          borderRadius: 6,
          padding: "4px 8px",
          fontSize: 12,
          background: "var(--app-elevated, #fff)",
          color: "var(--app-text, #1a1a2e)",
          cursor: "pointer",
        }}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {t.chrome.roleOptions[r]}
          </option>
        ))}
      </select>
    </label>
  );
}
