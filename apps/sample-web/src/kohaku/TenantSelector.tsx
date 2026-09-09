import type { ReactNode } from "react";
import { useT } from "../i18n/ui.js";
import { TENANTS, type Tenant, useTenant } from "./tenant.js";

/**
 * Tenant switch selector (permanently in the App header). The choice is persisted to localStorage and is carried on all
 * subsequent API calls as x-kohaku-tenant. Admin's View Lineage / promotion / fixation are isolated by
 * this tenant. The generated result (Spec) is tenant-independent — switching does not change the dashboard's display.
 */
export function TenantSelector(): ReactNode {
  const [tenant, setTenant] = useTenant();
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
      <span>{t.chrome.tenantLabel}</span>
      <select
        value={tenant}
        onChange={(e) => setTenant(e.target.value as Tenant)}
        aria-label={t.chrome.tenantSwitchAria}
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
        {TENANTS.map((id) => (
          <option key={id} value={id}>
            {id === "default" ? t.chrome.tenantDefaultLabel : id}
          </option>
        ))}
      </select>
    </label>
  );
}
